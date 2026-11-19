/**
 * firehose-fanout.ts — DynamoDB Streams → WebSocket live fan-out.
 *
 * Triggered by RepoTable stream (NEW_IMAGE). For each INSERT on an EVT# row,
 * extracts the stored `#commit` frame bytes and posts them to every active
 * WebSocket connection (CONN# items).
 *
 * Access pattern for CONN# listing:
 *   A DynamoDB Scan with FilterExpression `begins_with(pk,'CONN#')` is used.
 *   This is intentionally correct (not a pk Query BETWEEN — that was the Task-3
 *   Critical bug; pk needs an equality condition for Query). At single-tenant
 *   scale there are very few connections (usually just the bsky relay), so a
 *   filtered Scan over the small table is both correct and acceptably cheap.
 *
 * Error handling:
 *   - GoneException (HTTP 410): connection is dead → delete CONN# item, continue.
 *   - Other send errors: log + continue (best-effort; relays de-dupe by seq,
 *     so over-delivering is safe; we must never throw past the handler).
 *
 * Delivery order:
 *   Multiple EVT# INSERTs in one batch are delivered in ascending seq order
 *   (derived from the pad16 pk sort key).
 */

import {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda'
import {
  handleReplay,
  readCurrentSeq,
  readEvtFramesInRange,
} from './firehose-ws'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected deps for `fanout` — fully injectable for unit tests. */
export interface FanoutDeps {
  /** Return all active connectionIds (from CONN# items). */
  listConnections(): Promise<string[]>
  /** Post bytes to a WebSocket connection. May throw GoneException on 410. */
  send(connectionId: string, bytes: Uint8Array): Promise<void>
  /** Delete a stale CONN# item after receiving GoneException. */
  dropConnection(connectionId: string): Promise<void>
  /**
   * Perform the deferred cursor backlog replay for a freshly connected client.
   * This runs here (in the stream-triggered fanout Lambda) rather than in
   * $connect because API Gateway only makes a WS connection reachable by
   * postToConnection AFTER $connect returns — see firehose-ws.handleConnect.
   */
  replay(connectionId: string, cursor: number): Promise<void>
  /** Delete a processed REPLAY# marker. */
  dropReplayMarker(connectionId: string): Promise<void>
  /**
   * Notify external relays (e.g. `bsky.network`) that the PDS has new commits.
   *
   * Implementations POST `com.atproto.sync.requestCrawl` to each target with
   * `{ hostname: <pds-hostname> }`. Called once per `fanout()` invocation that
   * carries ≥1 EVT# INSERT — relays only need to know "something is new", they
   * crawl on their own via subscribeRepos. Fire-and-forget at the call-site:
   * `notifyRelays` MUST NOT throw past its own boundary; any error is logged
   * and swallowed (the WS firehose remains the source of truth — notify just
   * accelerates relay catch-up).
   */
  notifyRelays(): Promise<void>
}

// ---------------------------------------------------------------------------
// Pure fanout logic
// ---------------------------------------------------------------------------

/**
 * Extract EVT# INSERT records from the stream batch, sort ascending by seq
 * (the pad16 pk is lexicographically ordered so string sort works), fetch
 * active connections once, then deliver each frame to every connection.
 *
 * GoneException (410) → dropConnection, continue to next connection.
 * Other errors → log, continue (best-effort fan-out; relays de-dupe by seq).
 */
export async function fanout(
  records: DynamoDBRecord[],
  deps: FanoutDeps,
): Promise<void> {
  // 0. Deferred-replay markers first. A REPLAY#<connId> INSERT means a client
  //    just finished $connect and the WS handshake is now complete, so the
  //    backlog can finally be pushed (postToConnection works here, unlike in
  //    $connect where it always 410s). Process these before live fan-out so a
  //    new subscriber gets history before tailing — though relays de-dupe by
  //    seq, so strict ordering across the two phases is not required.
  const replayInserts = records.filter(
    (r) =>
      r.eventName === 'INSERT' &&
      (r.dynamodb?.NewImage?.pk as { S?: string } | undefined)?.S?.startsWith(
        'REPLAY#',
      ),
  )
  for (const rec of replayInserts) {
    const img = rec.dynamodb?.NewImage
    const connId = (img?.connectionId as { S?: string } | undefined)?.S
    const cursor = Number((img?.cursor as { N?: string } | undefined)?.N ?? 0)
    if (!connId) continue
    try {
      await deps.replay(connId, cursor)
    } catch (err) {
      // GoneException here means the client disconnected before replay — fine.
      const isGone =
        (err as { name?: string })?.name === 'GoneException' ||
        (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode === 410
      if (isGone) {
        console.info('[firehose-fanout] replay target gone', { connId })
      } else {
        console.error('[firehose-fanout] replay error (non-fatal)', {
          connId,
          err,
        })
      }
    } finally {
      // Always clear the marker — replay is best-effort; the relay will
      // reconnect with its last cursor if it missed anything.
      try {
        await deps.dropReplayMarker(connId)
      } catch (dropErr) {
        console.error('[firehose-fanout] failed to drop replay marker', {
          connId,
          dropErr,
        })
      }
    }
  }

  // 1. Filter to EVT# INSERTs only — ignore CONN#/SEQ/COMMIT#/ACCOUNT/REPLAY# and MODIFY/REMOVE.
  const evtInserts = records.filter(
    (r) =>
      r.eventName === 'INSERT' &&
      (r.dynamodb?.NewImage?.pk as { S?: string } | undefined)?.S?.startsWith('EVT#'),
  )

  if (evtInserts.length === 0) return

  // 1a. Notify external relays (bsky.network, etc.) that new commits exist.
  //     AWAITED (not fire-and-forget): in Lambda, handler-return freezes the
  //     event loop and unresolved fetches never complete. We await to guarantee
  //     the HTTP call runs to completion within the invocation lifetime, then
  //     swallow any error here so the local WS fan-out below is unaffected.
  //     Notify ONCE per batch (not per frame): relays only need to know
  //     "something is new", they crawl via subscribeRepos on their own. 5s
  //     timeout per target inside notifyOfUpdateAll bounds total cost.
  try {
    await deps.notifyRelays()
  } catch (err) {
    console.error('[firehose-fanout] notifyRelays threw past its boundary (swallowed)', { err })
  }

  // 2. Sort ascending by pk (pad16 ensures lexicographic = numeric order).
  evtInserts.sort((a, b) => {
    const pkA = (a.dynamodb?.NewImage?.pk as { S?: string })?.S ?? ''
    const pkB = (b.dynamodb?.NewImage?.pk as { S?: string })?.S ?? ''
    return pkA < pkB ? -1 : pkA > pkB ? 1 : 0
  })

  // 3. Extract frame bytes from each record.
  const frames: Uint8Array[] = []
  for (const record of evtInserts) {
    const raw = (record.dynamodb?.NewImage?.frame as { B?: unknown } | undefined)?.B
    if (!raw) {
      console.warn('[firehose-fanout] EVT# INSERT missing frame attribute — skipping', {
        pk: (record.dynamodb?.NewImage?.pk as { S?: string })?.S,
      })
      continue
    }
    frames.push(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike))
  }

  if (frames.length === 0) return

  // 4. List active connections (single Scan — OK at single-tenant scale).
  const connectionIds = await deps.listConnections()
  if (connectionIds.length === 0) return

  // 5. For each frame (ascending seq), deliver to all connections.
  // Track connections that have already been dropped this invocation so that a
  // dead connection in a multi-frame batch is cleaned up exactly once (not once
  // per frame), avoiding redundant DDB writes and log spam.
  const droppedConnIds = new Set<string>()
  for (const frameBytes of frames) {
    for (const connId of connectionIds) {
      // Skip connections already confirmed gone earlier in this batch.
      if (droppedConnIds.has(connId)) continue
      try {
        await deps.send(connId, frameBytes)
      } catch (err) {
        // GoneException: connection closed, clean up CONN# item.
        const isGone =
          (err as { name?: string })?.name === 'GoneException' ||
          (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 410
        if (isGone) {
          console.info('[firehose-fanout] connection gone, dropping', { connId })
          droppedConnIds.add(connId)
          try {
            await deps.dropConnection(connId)
          } catch (dropErr) {
            console.error('[firehose-fanout] failed to drop connection', { connId, dropErr })
          }
        } else {
          // Non-fatal: log and continue (best-effort, relays de-dupe by seq).
          console.error('[firehose-fanout] send error (non-fatal)', { connId, err })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Real AWS deps factory
// ---------------------------------------------------------------------------

/**
 * Post raw frame bytes to a WS connection as a BINARY message.
 *
 * Critical: pass a Node Buffer, not a bare Uint8Array. With a plain
 * Uint8Array the API Gateway Management API path UTF-8-sanitises the payload
 * and delivers it as a TEXT frame — every byte >= 0x80 (i.e. all DAG-CBOR
 * structural bytes) is replaced with the U+FFFD replacement char (EF BF BD),
 * corrupting the #commit frame so no relay can decode it. A Buffer is
 * marshalled as a binary blob, so API Gateway emits a binary WS frame and the
 * CBOR survives byte-for-byte. (This was the final firehose bug: frames were
 * delivered but arrived UTF-8-mangled.)
 */
async function postBinary(
  apigw: ApiGatewayManagementApiClient,
  connectionId: string,
  bytes: Uint8Array,
): Promise<void> {
  await apigw.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    }),
  )
}

// ---------------------------------------------------------------------------
// requestCrawl — fire-and-forget relay push
// ---------------------------------------------------------------------------

/**
 * POST `com.atproto.sync.requestCrawl` to each relay target, in parallel.
 * Per-target failures are LOGGED and SWALLOWED — never thrown past this call.
 *
 * Each target is a hostname (e.g. `bsky.network`); the POST URL is built as
 * `https://<target>/xrpc/com.atproto.sync.requestCrawl`. The body carries
 * `{ hostname: <our pds hostname> }` per the AT-Proto lexicon.
 *
 * Why requestCrawl (not notifyOfUpdate): bsky.network's current relay
 * (`rainbow`) returns HTTP 404 for `notifyOfUpdate` — that procedure is
 * deprecated in newer atproto. `requestCrawl` carries the same semantics for
 * our use case (the relay queues a crawl that pulls via subscribeRepos) and
 * returns 200 — live-verified on `bsky.network` before this switch. The
 * exported function name keeps the legacy "notifyOfUpdate" branding because
 * the deps interface uses `notifyRelays` and the function is a generic
 * "tell each relay we have news" — the lexicon-level endpoint can be swapped
 * again without touching the call site.
 *
 * A 5-second per-target timeout protects against slow/hanging relays — even
 * if all targets time out, total cost is bounded.
 *
 * Exported for direct test access (so unit tests can pin both the URL and the
 * timeout-resilience behavior without going through buildRealDeps).
 */
export async function notifyOfUpdateAll(
  targets: ReadonlyArray<string>,
  pdsHostname: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<void> {
  if (targets.length === 0) return
  await Promise.all(
    targets.map(async (target) => {
      const url = `https://${target}/xrpc/com.atproto.sync.requestCrawl`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hostname: pdsHostname }),
          signal: controller.signal,
        })
        if (res.status >= 200 && res.status < 300) {
          console.info('[firehose-fanout] requestCrawl OK', {
            target,
            status: res.status,
          })
        } else {
          // Non-2xx is logged but not retried — relays poll on their own cadence,
          // so missing a single notify is recoverable.
          console.warn('[firehose-fanout] requestCrawl non-2xx (ignored)', {
            target,
            status: res.status,
          })
        }
      } catch (err) {
        const isAbort = (err as { name?: string })?.name === 'AbortError'
        console.warn(
          isAbort
            ? '[firehose-fanout] requestCrawl timed out (ignored)'
            : '[firehose-fanout] requestCrawl failed (ignored)',
          { target, err: (err as Error)?.message ?? String(err) },
        )
      } finally {
        clearTimeout(timer)
      }
    }),
  )
}

function buildRealDeps(
  ddb: DynamoDBClient,
  table: string,
  apigw: ApiGatewayManagementApiClient,
): FanoutDeps {
  return {
    listConnections: async () => {
      // Scan RepoTable, filtering to pk beginning with 'CONN#'.
      // Correct access pattern: Scan + FilterExpression (NOT Query BETWEEN on pk).
      // At single-tenant scale this is cheap and correct.
      const connectionIds: string[] = []
      let lastKey: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> | undefined

      do {
        const res = await ddb.send(
          new ScanCommand({
            TableName: table,
            FilterExpression: 'begins_with(pk, :prefix)',
            ExpressionAttributeValues: { ':prefix': { S: 'CONN#' } },
            ExclusiveStartKey: lastKey,
            // ProjectionExpression so we only fetch the pk (connectionId embedded in it).
            ProjectionExpression: 'pk',
          }),
        )
        for (const item of res.Items ?? []) {
          const pk = item.pk?.S
          if (pk && pk.startsWith('CONN#')) {
            // Strip 'CONN#' prefix to get the raw connectionId.
            connectionIds.push(pk.slice(5))
          }
        }
        lastKey = res.LastEvaluatedKey
      } while (lastKey)

      return connectionIds
    },

    send: (connectionId: string, bytes: Uint8Array) =>
      postBinary(apigw, connectionId, bytes),

    dropConnection: async (connectionId: string) => {
      await ddb.send(
        new DeleteItemCommand({
          TableName: table,
          Key: {
            pk: { S: `CONN#${connectionId}` },
            sk: { S: 'CONN' },
          },
        }),
      )
    },

    replay: async (connectionId: string, cursor: number) => {
      // Reuse the EXACT replay semantics + EVT/SEQ readers from firehose-ws.
      await handleReplay(
        { connectionId, cursor },
        {
          getSeq: () => readCurrentSeq(ddb, table),
          getEvtFramesInRange: (from: number, to: number) =>
            readEvtFramesInRange(ddb, table, from, to),
          send: (connId: string, bytes: Uint8Array) =>
            postBinary(apigw, connId, bytes),
        },
      )
    },

    dropReplayMarker: async (connectionId: string) => {
      await ddb.send(
        new DeleteItemCommand({
          TableName: table,
          Key: {
            pk: { S: `REPLAY#${connectionId}` },
            sk: { S: 'REPLAY' },
          },
        }),
      )
    },

    notifyRelays: async () => {
      // Comma-separated hostnames (no scheme), e.g. "bsky.network,relay2.example".
      // Empty or unset → no notify (test/dev mode + safe rollout default).
      const raw = process.env.NOTIFY_OF_UPDATE_TARGETS ?? ''
      const targets = raw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      const pdsHostname = process.env.PDS_HOSTNAME ?? ''
      if (targets.length === 0 || pdsHostname === '') return
      await notifyOfUpdateAll(targets, pdsHostname)
    },
  }
}

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const table = process.env.REPO_TABLE ?? ''
  const endpoint = process.env.WS_MGMT_ENDPOINT ?? ''

  try {
    const ddb = new DynamoDBClient({})
    const apigw = new ApiGatewayManagementApiClient({ endpoint })
    const deps = buildRealDeps(ddb, table, apigw)
    await fanout(event.Records, deps)
  } catch (err) {
    // Never throw past the handler — DDB Streams will retry; log for visibility.
    console.error('[firehose-fanout] unhandled error in handler', { err })
  }
}
