/**
 * firehose-ws.ts — AT Protocol subscribeRepos WebSocket handler.
 *
 * Routes: $connect / $disconnect / $default (all handled here; APIGW dispatches
 * via event.requestContext.routeKey).
 *
 * CONN# layout in RepoTable (pk/sk):
 *   CONN#<connectionId> / CONN  { cursor, connectedAt, ttl }
 *
 * Replay reads EVT# rows from sequencer.ts's DDB layout:
 *   EVT#<pad16(seq)> / EVT  { frame:Binary, seq:Number, ttl }
 *
 * Pure functions (handleConnect / handleDisconnect / handleDefault) receive
 * injected deps so they are fully unit-testable without any AWS calls.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda'
import { planReplay, fetchEvtRange } from './firehose-core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectDeps {
  /** Read the current max seq from SEQ/SEQ. Returns 0 if not yet set. */
  getSeq(): Promise<number>
  /**
   * BatchGet all EVT# frames in the half-open range (fromExclusive, toInclusive]
   * by computing exact keys. Returns only retained (non-TTL-expired) items,
   * sorted ascending by seq. Missing keys are silently absent (TTL aged out).
   *
   * Also provides `earliestRetainedSeq` — the smallest seq actually returned —
   * so the caller can detect OutdatedCursor without a second pass.
   */
  getEvtFramesInRange(
    fromExclusive: number,
    toInclusive: number,
  ): Promise<{ frames: Array<{ seq: number; frame: Uint8Array }>; earliestRetainedSeq: number | null }>
  /** Write CONN#<connectionId>/CONN registration, using the provided nowMs for TTL. */
  putConn(connectionId: string, cursor: number, nowMs: number): Promise<void>
  /** Delete CONN#<connectionId>/CONN. */
  deleteConn(connectionId: string): Promise<void>
  /**
   * Write a REPLAY#<connectionId>/REPLAY marker so the DDB-stream fanout Lambda
   * performs the cursor backlog replay AFTER the WS handshake completes.
   *
   * Critical: API Gateway WebSocket does not establish the connection until the
   * $connect Lambda returns 200, so calling postToConnection from within
   * $connect always fails with 410 GoneException. The backlog replay must
   * therefore be deferred to a post-$connect execution context. The fanout
   * Lambda (already stream-triggered, already holding the correct execute-api
   * WS_MGMT_ENDPOINT and ManageConnections grant) is exactly that context.
   */
  putReplayMarker(connectionId: string, cursor: number, nowMs: number): Promise<void>
  /**
   * Send bytes to a connected WS client. Used only by handleReplay (which runs
   * post-$connect, when the connection is established) — never from $connect.
   */
  send(connectionId: string, bytes: Uint8Array): Promise<void>
  /** Current epoch-ms (injectable for tests). */
  now(): number
}

export type DisconnectDeps = Pick<ConnectDeps, 'deleteConn'>

// ---------------------------------------------------------------------------
// Pure handlers
// ---------------------------------------------------------------------------

const CONN_SK = 'CONN'
export const REPLAY_SK = 'REPLAY'
/** REPLAY#<connectionId> pk builder — shared with the fanout Lambda. */
export const replayPkFor = (connectionId: string) => `REPLAY#${connectionId}`
const TWO_HOURS_S = 2 * 60 * 60

/**
 * Handle $connect.
 *
 * IMPORTANT — why this does no postToConnection:
 *   API Gateway WebSocket only completes the handshake (and makes the
 *   connection reachable by postToConnection) AFTER the $connect Lambda
 *   returns 200. Any postToConnection issued from within $connect targets a
 *   connection that does not exist yet → 410 GoneException, every time.
 *
 *   So $connect ONLY: (1) validates the cursor, (2) registers the connection,
 *   and (3) writes a REPLAY# marker. The actual backlog send (FutureCursor /
 *   OutdatedCursor / frames) is performed by handleReplay, which runs from the
 *   DDB-stream fanout Lambda — a context that executes after $connect returned,
 *   when the connection is live.
 *
 * Cursor handling (resolved here, acted on in handleReplay):
 *   - undefined / negative / non-finite → treat as 0 (replay from beginning)
 *   - any value (incl. > currentSeq)     → stored on the REPLAY# marker;
 *                                          handleReplay emits FutureCursor when
 *                                          the marker's cursor is ahead of head.
 */
export async function handleConnect(
  { connectionId, cursor }: { connectionId: string; cursor: string | undefined },
  deps: ConnectDeps,
): Promise<void> {
  const parsedCursor =
    cursor !== undefined ? parseInt(cursor, 10) : undefined
  // Reject non-finite values AND negative cursors (treat as no-cursor → 0).
  const numericCursor =
    parsedCursor !== undefined && Number.isFinite(parsedCursor) && parsedCursor >= 0
      ? parsedCursor
      : 0

  // Register the connection (cursor stored is 0 when not supplied) and write
  // the REPLAY# marker. NO postToConnection here — see the note above.
  const nowMs = deps.now()
  await deps.putConn(connectionId, numericCursor, nowMs)
  await deps.putReplayMarker(connectionId, numericCursor, nowMs)
}

/**
 * handleReplay — the deferred backlog send. Runs from the fanout Lambda when a
 * REPLAY#<connectionId> marker INSERT is observed (i.e. AFTER $connect returned
 * and the WS connection is established, so postToConnection works).
 *
 * Mirrors the original $connect cursor semantics exactly:
 *   - cursor > currentSeq            → FutureCursor error frame, stop.
 *   - cursor >= currentSeq           → nothing to replay.
 *   - earliestRetained > cursor+1    → OutdatedCursor #info frame, then frames.
 *   - otherwise                      → replay retained frames ascending.
 */
export async function handleReplay(
  { connectionId, cursor }: { connectionId: string; cursor: number },
  deps: Pick<ConnectDeps, 'getSeq' | 'getEvtFramesInRange' | 'send'>,
): Promise<void> {
  const currentSeq = await deps.getSeq()

  const result = await planReplay(
    currentSeq,
    cursor,
    (fromExclusive, toInclusive) =>
      deps.getEvtFramesInRange(fromExclusive, toInclusive),
  )

  if (result.mode === 'future') {
    await deps.send(connectionId, result.error!)
    return
  }

  if (result.mode === 'outdated' && result.info) {
    await deps.send(connectionId, result.info)
  }

  for (const frame of result.frames) {
    await deps.send(connectionId, frame)
  }
}

/** Handle $disconnect — remove CONN# item. */
export async function handleDisconnect(
  { connectionId }: { connectionId: string },
  deps: DisconnectDeps,
): Promise<void> {
  await deps.deleteConn(connectionId)
}

/**
 * Handle $default — the relay never sends messages on the firehose stream, so
 * this is a no-op. Return 200 so APIGW doesn't drop the frame.
 */
export async function handleDefault(): Promise<void> {
  // intentional no-op
}

// ---------------------------------------------------------------------------
// Shared EVT/SEQ readers — used by both the WS handler (deferred replay path)
// and the fanout Lambda. Exported so the replay performed post-$connect reuses
// the EXACT same read logic, no duplication.
// ---------------------------------------------------------------------------

/** Read the current max seq from SEQ/SEQ. Returns 0 if not yet set. */
export async function readCurrentSeq(
  ddb: DynamoDBClient,
  table: string,
): Promise<number> {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: table,
      Key: { pk: { S: 'SEQ' }, sk: { S: 'SEQ' } },
    }),
  )
  return Number(res.Item?.value?.N ?? 0)
}

/**
 * BatchGet all retained EVT# frames in (fromExclusive, toInclusive], sorted
 * ascending by seq. Returns earliestRetainedSeq for OutdatedCursor detection.
 *
 * Delegates to fetchEvtRange from firehose-core (same logic, no duplication).
 * Exported for backward-compat with firehose-fanout.ts.
 */
export async function readEvtFramesInRange(
  ddb: DynamoDBClient,
  table: string,
  fromExclusive: number,
  toInclusive: number,
): Promise<{
  frames: Array<{ seq: number; frame: Uint8Array }>
  earliestRetainedSeq: number | null
}> {
  return fetchEvtRange(ddb, table, fromExclusive, toInclusive)
}

// ---------------------------------------------------------------------------
// Real AWS deps factory
// ---------------------------------------------------------------------------

function buildRealDeps(
  event: APIGatewayProxyWebsocketEventV2,
  ddb: DynamoDBClient,
  table: string,
  apigw: ApiGatewayManagementApiClient,
): ConnectDeps {
  const connPk = (id: string) => `CONN#${id}`
  const replayPk = replayPkFor

  return {
    now: () => Date.now(),

    getSeq: () => readCurrentSeq(ddb, table),

    getEvtFramesInRange: (fromExclusive: number, toInclusive: number) =>
      readEvtFramesInRange(ddb, table, fromExclusive, toInclusive),

    putConn: async (connectionId: string, cursor: number, nowMs: number) => {
      const nowSec = Math.floor(nowMs / 1000)
      await ddb.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            pk: { S: connPk(connectionId) },
            sk: { S: CONN_SK },
            cursor: { N: String(cursor) },
            connectedAt: { S: new Date(nowMs).toISOString() },
            ttl: { N: String(nowSec + TWO_HOURS_S) },
          },
        }),
      )
    },

    deleteConn: async (connectionId: string) => {
      await ddb.send(
        new DeleteItemCommand({
          TableName: table,
          Key: {
            pk: { S: connPk(connectionId) },
            sk: { S: CONN_SK },
          },
        }),
      )
    },

    putReplayMarker: async (
      connectionId: string,
      cursor: number,
      nowMs: number,
    ) => {
      const nowSec = Math.floor(nowMs / 1000)
      await ddb.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            pk: { S: replayPk(connectionId) },
            sk: { S: REPLAY_SK },
            cursor: { N: String(cursor) },
            connectionId: { S: connectionId },
            createdAt: { S: new Date(nowMs).toISOString() },
            // Short TTL — the marker only needs to survive long enough for the
            // DDB stream to deliver the INSERT to the fanout Lambda. The fanout
            // also deletes it explicitly after replaying.
            ttl: { N: String(nowSec + TWO_HOURS_S) },
          },
        }),
      )
    },

    send: async (connectionId: string, bytes: Uint8Array) => {
      await apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: bytes,
        }),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<{ statusCode: number }> => {
  const table = process.env.REPO_TABLE ?? ''
  const { routeKey, connectionId, domainName, stage } = event.requestContext

  try {
    const ddb = new DynamoDBClient({})
    const apigw = new ApiGatewayManagementApiClient({
      endpoint: `https://${domainName}/${stage}`,
    })
    const deps = buildRealDeps(event, ddb, table, apigw)

    switch (routeKey) {
      case '$connect': {
        const cursor =
          (event as { queryStringParameters?: Record<string, string> })
            .queryStringParameters?.cursor
        await handleConnect({ connectionId, cursor }, deps)
        break
      }
      case '$disconnect':
        await handleDisconnect({ connectionId }, deps)
        break
      default:
        await handleDefault()
        break
    }
  } catch (err) {
    console.error('[firehose-ws] unhandled error', { routeKey, connectionId, err })
    // Return 200 regardless to prevent APIGW from retrying/dropping the connection.
  }

  return { statusCode: 200 }
}
