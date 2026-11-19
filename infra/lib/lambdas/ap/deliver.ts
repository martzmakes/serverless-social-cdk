/**
 * ap/deliver.ts — additive RepoTable-stream delivery consumer (Task 7 / Spec #7 / Phase C).
 *
 * CARDINAL RULE: purely additive read-side consumer. NEVER writes the AT repo,
 * firehose, the DID document, or the sequencer. Reads only (loadPostRecord via listRecords).
 * The firehose path is structurally untouched — this is a SEPARATE DDB-stream
 * consumer from the longform-renderer. Task 9 wires its own ESM + DLQ; do NOT
 * modify the longform-renderer construct or any pds/ file.
 *
 * DELIVERY CONTRACT (Task 9): the AT write is already committed and federated
 * before this consumer runs and is never rolled back. A delivery failure to ONE
 * follower is logged (structured console.error) and never blocks the other
 * followers. Retryable failures (5xx, 429/408, network) are handed to the SQS
 * retry queue (backoff + DLQ, see ap/retry.ts) instead of being dropped; 4xx
 * are permanent and not retried; 410 removes the follower. Infrastructure
 * errors (tenant/followers/record reads, enqueue) are rethrown AFTER every
 * event in the batch was attempted so the DynamoDB stream retries the batch:
 * that is safe because every (activityId, inbox) send is claimed in an
 * idempotency ledger first, so a replayed batch cannot double-deliver.
 *
 * INJECTED-DEPS PATTERN (G2 cardinal-rule guard): this module is PURE / dep-injected.
 * It does NOT import ../pds/storage, ../pds/sequencer, or ../pds/repo-write.
 * Importing APEX_DID from ../pds/tenant-keys is ALLOWED — it is a plain const,
 * not the AT repo-row key resolver (the nonregression test verifies: importing
 * tenant-keys is OK as long as the key-resolver symbol is not referenced).
 *
 * ESM filter vs sub-user pk form (resolved in Task 7/9):
 *   A DynamoDB ESM prefix filter `RECORD#app.bsky.feed.post/` matches ONLY the
 *   apex pk form. Sub-user RECORD rows start with `<did>#RECORD#app.bsky.feed.post/`,
 *   so they do NOT match a bare-prefix ESM filter configured for the apex form.
 *   Task 9's ESM filter configuration AND the Task 11 live-proof MUST account
 *   for this: either the ESM filter must be omitted (accept all RECORD rows and
 *   let eventsFromStream do the filtering), or a second filter-prefix for sub-users
 *   must be added. This module correctly parses both forms once they arrive —
 *   the problem is upstream in the ESM trigger configuration (Task 9/11).
 *
 * @context on delivered body: Mastodon requires the delivered Create activity to
 *   carry `@context: 'https://www.w3.org/ns/activitystreams'` at top level.
 *   wrapCreate() (from outbox.ts) does NOT add @context — it is added here, at
 *   the deliver layer, as `{ '@context': AS_CONTEXT, ...create }`.
 *   Do NOT change wrapCreate's return type or the outbox-page shape.
 */

import {
  postToNote,
  longformToArticle,
  type AtLongform,
  type ApNote,
  type ApArticle,
} from './translate'
import { wrapCreate, wrapUpdate, wrapDelete } from './outbox'
import type { signRequest as SignRequestFn } from './httpsig'
import { APEX_DID } from '../pds/tenant-keys'
import { canonicalApOrigin, pageOriginFor } from './host'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COLL_POST = 'app.bsky.feed.post'
export const COLL_LONGFORM = 'social.serverless.longform'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

/** First retry delay (SQS DelaySeconds) after a failed first attempt. */
export const FIRST_RETRY_DELAY_SECONDS = 30
/** Delay before re-checking a send whose ledger claim is held by another attempt
 *  (> the 120 s lease in ap-deps.ts, so an abandoned lease has expired). */
export const INFLIGHT_RETRY_DELAY_SECONDS = 150
/** Delay before re-checking a longform whose page the renderer has not published. */
export const NOT_READY_DELAY_SECONDS = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliverCollection = typeof COLL_POST | typeof COLL_LONGFORM

/** A parsed, normalized event from the DDB stream (output of eventsFromStream). */
export interface DeliverEvent {
  /** The DID of the post author. Apex = APEX_DID; sub-user = the leading <did>. */
  did: string
  /** The record rkey. */
  rkey: string
  /** create = INSERT, update = MODIFY, delete = REMOVE. */
  op: 'create' | 'update' | 'delete'
  /** Defaults to app.bsky.feed.post when omitted. */
  collection?: DeliverCollection
  /** Record cid from the stream NewImage (versions an Update; matches the
   *  longform index cid once the renderer has caught up). */
  cid?: string
  /** ISO approximate stream-record time (deterministic Update `updated`). */
  at?: string
}

/** Follower entry with actorId and inbox URL (needed for delivery). */
export interface DeliverFollower {
  actorId: string
  inbox: string
}

/** What the retry queue carries. Bodies are pre-built; signing is redone at
 *  send time (a signed Date older than the receiver's skew window is useless). */
export type RetryMessage =
  | {
      kind: 'deliver'
      handle: string
      activityId: string
      inbox: string
      /** Follower actor ids behind this inbox (removed on 410). */
      actorIds: string[]
      /** The exact JSON body to POST. */
      body: string
    }
  | { kind: 'event'; event: DeliverEvent }

export interface RetryQueue {
  enqueue(msg: RetryMessage, delaySeconds?: number): Promise<void>
}

/** Per-(activityId, inbox) idempotency ledger (DynamoDB conditional writes, TTL). */
export interface DeliveryLedger {
  /**
   * Atomically claim a key.
   *  true       claimed - go send it
   *  false      already delivered (or permanently rejected): skip
   *  'inflight' another attempt holds an unexpired lease and has NOT finished.
   *             That attempt may have crashed or timed out mid-send, so the
   *             caller must NOT treat the send as done: it re-checks later
   *             (the lease expires, or the key turns 'done').
   */
  claim(key: string): Promise<boolean | 'inflight'>
  /** Mark a claimed key permanently done (delivered or permanently rejected). */
  complete(key: string, outcome?: CompletedDelivery): Promise<void>
  /** Release a claim so a retry can send it again. */
  release(key: string): Promise<void>
  result?(key: string): Promise<CompletedDelivery | undefined>
}

export interface LongformIndexEntry {
  /** The slug the renderer published the page under. */
  slug: string
  /** Record cid the renderer rendered. */
  cid: string
  status: 'published' | 'deleted'
}

/**
 * Injected dependency bundle for the deliver consumer.
 *
 * All deps are injected for testability (no real AWS/network in unit tests).
 * The real implementations live in ../ap-deps.ts (makeDeliverDeps).
 */
export interface DeliverDeps {
  /**
   * Resolve a DID to its handle. Returns null if the tenant is unknown or
   * suspended (skip and log). Apex short-circuits to APEX_HANDLE without
   * a DDB read.
   */
  resolveHandle(did: string): Promise<{ handle: string } | null>

  /**
   * Load an app.bsky.feed.post record value by (did, rkey). Returns null if
   * the record is not found or has been deleted (skip and log, best-effort).
   * The real impl reads via DynamoRepoStorage.listRecords (outside ap/**).
   */
  loadPostRecord(
    did: string,
    rkey: string,
  ): Promise<{
    text?: string
    createdAt?: string
    facets?: any[]
    reply?: boolean
    embed?: { external?: { uri?: string } }
  } | null>

  /** Load a social.serverless.longform record, or null when gone. */
  loadLongform(did: string, rkey: string): Promise<AtLongform | null>

  /**
   * The renderer's longform index entry for (did, rkey), or null if the
   * renderer has not written one yet. The slug there is the page that exists.
   */
  getLongformIndex(did: string, rkey: string): Promise<LongformIndexEntry | null>

  isBlueskyOnly?(did: string, rkey: string): Promise<boolean>

  /**
   * True when this feed.post is the renderer's syndication link post for a
   * longform of the SAME tenant: its external embed points at that longform's
   * canonical page. Such a post must not be federated as a second item.
   */
  isSyndicationLink(
    did: string,
    rkey: string,
    embedUri: string,
    pageOrigin: string,
  ): Promise<boolean>

  /** AP followers store (returns {actorId, inbox}[] — richer than ApFollowersStore.list). */
  followers: {
    list(handle: string): Promise<DeliverFollower[]>
    remove(handle: string, actorId: string): Promise<void>
  }

  /** Idempotency ledger keyed `${activityId}|${inbox}`. */
  ledger: DeliveryLedger

  /** SQS retry queue (backoff + DLQ). */
  retryQueue: RetryQueue

  /**
   * Load (or mint) the AP RSA keypair for a handle.
   * Only privatePem is needed for signing outbound deliveries.
   */
  getApKey(handle: string): Promise<{ privatePem: string }>

  /**
   * Sign an outbound HTTP POST (draft-cavage rsa-sha256).
   * Returns the request headers to attach to the delivery POST.
   * Injected so tests provide a mock without crypto I/O.
   */
  signRequest: typeof SignRequestFn

  /**
   * POST a pre-signed body to a remote inbox.
   * The real impl in ap-deps.ts MUST call assertSafeRemoteUrl before fetch
   * (https-only, no IMDS/RFC1918/internal hosts, timeout).
   * Returns { status }. A thrown error carrying `permanent: true` (SSRF guard
   * refusal) is never retried; any other throw is treated as transient.
   */
  postFetch(
    url: string,
    opts: { headers: Record<string, string>; body: Buffer },
  ): Promise<{ status: number }>

  /** Handles served from their own host (env AP_CUSTOM_HOSTS). Optional. */
  customHosts?: string[]
}

/** 'stream' = first attempt from the DynamoDB stream; 'retry' = SQS consumer. */
export type DeliverMode = 'stream' | 'retry'

/** Retry-mode signal: this send failed transiently; let SQS back off + redrive. */
export class RetryableDeliveryError extends Error {}
/** Retry-mode signal: the renderer has not published the longform page yet. */
export class NotReadyError extends Error {}

// ---------------------------------------------------------------------------
// eventsFromStream — parse DDB stream records
// ---------------------------------------------------------------------------

/**
 * Parse a DynamoDB stream event into DeliverEvent[]s.
 *
 * Accepts BOTH pk forms produced by pds/tenant-keys.ts (the record key builder)
 * for BOTH federated collections (app.bsky.feed.post, social.serverless.longform):
 *   apex:     RECORD#<collection>/<rkey>
 *   sub-user: <did>#RECORD#<collection>/<rkey>
 *
 * INSERT -> create, MODIFY -> update, REMOVE -> delete. Anything else (other
 * collections, blocks, account rows, malformed pks) yields nothing.
 */
export function eventsFromStream(event: { Records: any[] }): DeliverEvent[] {
  const evs: DeliverEvent[] = []
  const OPS: Record<string, DeliverEvent['op']> = {
    INSERT: 'create',
    MODIFY: 'update',
    REMOVE: 'delete',
  }

  for (const r of event.Records || []) {
    const op = OPS[r.eventName]
    if (!op) continue

    const pk: string | undefined = r.dynamodb?.Keys?.pk?.S
    if (!pk) continue

    for (const collection of [COLL_POST, COLL_LONGFORM] as const) {
      const apexPrefix = `RECORD#${collection}/`
      let did: string
      let rkey: string
      if (pk.startsWith(apexPrefix)) {
        did = APEX_DID
        rkey = pk.slice(apexPrefix.length)
      } else {
        const subInfix = `#RECORD#${collection}/`
        const subIdx = pk.indexOf(subInfix)
        if (subIdx <= 0) continue
        did = pk.slice(0, subIdx)
        rkey = pk.slice(subIdx + subInfix.length)
      }
      if (!rkey) break // malformed pk — skip defensively

      const ev: DeliverEvent = { did, rkey, op, collection }
      const cid: string | undefined = r.dynamodb?.NewImage?.cid?.S
      if (cid) ev.cid = cid
      const secs = r.dynamodb?.ApproximateCreationDateTime
      if (typeof secs === 'number') ev.at = new Date(secs * 1000).toISOString()
      evs.push(ev)
      break
    }
  }

  return evs
}

// ---------------------------------------------------------------------------
// processStream — delivery consumer
// ---------------------------------------------------------------------------

/**
 * Process a batch of DeliverEvents and fan out to each follower's inbox.
 *
 * Every event is attempted. If any event hit an infrastructure error the FIRST
 * such error is rethrown after the loop, so the stream retries the batch
 * (idempotent via the ledger) and eventually DLQs it. Per-follower delivery
 * failures never throw here: they go to the SQS retry queue.
 */
export async function processStream(
  events: DeliverEvent[],
  deps: DeliverDeps,
): Promise<void> {
  const failures: Error[] = []
  for (const ev of events) {
    try {
      await processOne(ev, deps, 'stream')
    } catch (e: any) {
      console.error(
        JSON.stringify({
          at: 'ap.deliver',
          event: 'record_failed',
          did: ev.did,
          rkey: ev.rkey,
          op: ev.op,
          message: e?.message,
        }),
      )
      failures.push(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (failures.length) throw failures[0]
}

const objectIdFor = (
  collection: DeliverCollection,
  origin: string,
  handle: string,
  rkey: string,
): string =>
  collection === COLL_LONGFORM
    ? `${origin}/ap/users/${handle}/articles/${rkey}`
    : `${origin}/ap/users/${handle}/posts/${rkey}`

interface BuiltActivity {
  id: string
  doc: Record<string, unknown>
}

/**
 * Build the activity for an event, or null when there is nothing to send
 * (record gone, syndication link, or - stream mode - the page is not ready and
 * a re-check was queued). Retry mode throws NotReadyError instead of queueing.
 */
async function buildActivity(
  ev: DeliverEvent,
  handle: string,
  origin: string,
  actorId: string,
  deps: DeliverDeps,
  mode: DeliverMode,
): Promise<BuiltActivity | null> {
  const { did, rkey } = ev
  const collection = ev.collection ?? COLL_POST
  const objectId = objectIdFor(collection, origin, handle, rkey)
  const followers = `${actorId}/followers`

  if (ev.op === 'delete') {
    if (collection === COLL_POST && await deps.isBlueskyOnly?.(did, rkey)) return null
    const del = wrapDelete(actorId, objectId, [AS_PUBLIC], [followers], `${objectId}#delete`)
    return { id: del.id, doc: { '@context': AS_CONTEXT, ...del } }
  }

  const updated = ev.op === 'update' ? (ev.at ?? new Date().toISOString()) : undefined
  const version = ev.cid ?? ev.at ?? 'edit'
  let item: ApNote | ApArticle

  if (collection === COLL_LONGFORM) {
    const rec = await deps.loadLongform(did, rkey)
    if (!rec) {
      logSkip('record_not_found', ev, handle)
      return null
    }
    // ORDERING: the longform INSERT reaches this consumer and the renderer in
    // parallel. The page URL is only real once the renderer has written the
    // page and its index entry (slug can be normalized or collision-suffixed).
    // Never guess: delivering a URL that 404s is a bug.
    const idx = await deps.getLongformIndex(did, rkey)
    const ready =
      !!idx && idx.status === 'published' && (!ev.cid || idx.cid === ev.cid)
    if (!ready) {
      if (mode === 'retry') throw new NotReadyError('longform page not published yet')
      console.warn(
        JSON.stringify({
          at: 'ap.deliver',
          event: 'longform_not_ready_requeued',
          did,
          rkey,
          handle,
        }),
      )
      await deps.retryQueue.enqueue({ kind: 'event', event: ev }, NOT_READY_DELAY_SECONDS)
      return null
    }
    item = longformToArticle({
      rkey,
      record: rec,
      handle,
      origin,
      pageOrigin: pageOriginFor(handle),
      slug: idx!.slug,
      updated,
    })
  } else {
    const record = await deps.loadPostRecord(did, rkey)
    if (!record) {
      logSkip('record_not_found', ev, handle)
      return null
    }
    if ((record.reply || ev.op === 'update') && await deps.isBlueskyOnly?.(did, rkey)) return null
    const embedUri = record.embed?.external?.uri
    if (
      typeof embedUri === 'string' &&
      (await deps.isSyndicationLink(did, rkey, embedUri, pageOriginFor(handle)))
    ) {
      // The renderer's Bluesky link post for a longform we federate as an
      // Article. Delivering it too would show the post twice.
      logSkip('syndication_link_suppressed', ev, handle)
      return null
    }
    const note = postToNote({
      rkey,
      record: {
        text: record.text ?? '',
        createdAt: record.createdAt ?? new Date().toISOString(),
        facets: record.facets,
      },
      handle,
      origin,
    })
    if (updated) note.updated = updated
    item = note
  }

  if (ev.op === 'update') {
    const upd = wrapUpdate(actorId, item, `${item.id}#updates/${version}`)
    return { id: upd.id, doc: { '@context': AS_CONTEXT, ...upd } }
  }
  // wrapCreate does NOT add @context — added here (Mastodon requires it).
  const create = wrapCreate(actorId, item)
  return { id: create.id, doc: { '@context': AS_CONTEXT, ...create } }
}

function logSkip(event: string, ev: DeliverEvent, handle: string): void {
  console.error(
    JSON.stringify({
      at: 'ap.deliver',
      event,
      did: ev.did,
      rkey: ev.rkey,
      handle,
    }),
  )
}

/** Group followers by inbox so a shared inbox is POSTed to once. */
function dedupeByInbox(list: DeliverFollower[]): Map<string, string[]> {
  const byInbox = new Map<string, string[]>()
  for (const f of list) {
    const ids = byInbox.get(f.inbox)
    if (ids) ids.push(f.actorId)
    else byInbox.set(f.inbox, [f.actorId])
  }
  return byInbox
}

/** Resolve and process one event. Exported for the SQS retry consumer. */
export async function processOne(
  ev: DeliverEvent,
  deps: DeliverDeps,
  mode: DeliverMode,
): Promise<void> {
  const { did, rkey } = ev

  // 1. Resolve handle
  const tenant = await deps.resolveHandle(did)
  if (!tenant) {
    console.error(
      JSON.stringify({ at: 'ap.deliver', event: 'tenant_not_found', did, rkey }),
    )
    return
  }
  const { handle } = tenant

  // 2. Followers first - no work (no record load) if nobody follows.
  const byInbox = dedupeByInbox(await deps.followers.list(handle))
  if (byInbox.size === 0) return

  // 3. Build the activity
  const origin = canonicalApOrigin(handle, deps.customHosts ?? [])
  const actorId = `${origin}/ap/users/${handle}`
  const built = await buildActivity(ev, handle, origin, actorId, deps, mode)
  if (!built) return
  const body = Buffer.from(JSON.stringify(built.doc), 'utf8')

  // 4. Fan out - per-follower isolation. Infra errors (enqueue) are collected
  //    and rethrown after every inbox was attempted.
  const { privatePem } = await deps.getApKey(handle)
  const signer = { keyId: `${actorId}#main-key`, privatePem }
  const results = await Promise.allSettled(
    [...byInbox.entries()].map(([inbox, actorIds]) =>
      deliverOne(
        { handle, activityId: built.id, inbox, actorIds, body },
        signer,
        deps,
        mode,
      ),
    ),
  )
  const rejected = results.find((r) => r.status === 'rejected') as
    | PromiseRejectedResult
    | undefined
  if (rejected) throw rejected.reason
}

// ---------------------------------------------------------------------------
// deliverOne — one (activity, inbox) send: ledger, classify, retry/remove
// ---------------------------------------------------------------------------

export interface DeliverJob {
  handle: string
  activityId: string
  inbox: string
  actorIds: string[]
  body: Buffer
}

export type CompletedDelivery = 'delivered' | 'gone' | 'rejected'
export type DeliveryOutcome = CompletedDelivery | 'duplicate' | 'retry_queued'
export type DeliveryTransport = Pick<DeliverDeps, 'ledger' | 'retryQueue' | 'signRequest' | 'postFetch' | 'followers'>

/** 429/408 and 5xx are transient; any other non-2xx is the remote saying no. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

/**
 * Send one activity to one inbox, exactly once per (activityId, inbox):
 *  - ledger.claim first; a lost claim means delivered/in-flight -> skip
 *  - 2xx -> complete
 *  - 410 -> remove the follower(s), complete
 *  - other 4xx / SSRF-refused -> permanent: log, complete, no retry
 *  - 5xx / 429 / 408 / network -> release; stream mode queues an SQS retry,
 *    retry mode throws RetryableDeliveryError (SQS redrives with backoff, DLQ
 *    after maxReceiveCount)
 */
export async function deliverOne(
  job: DeliverJob,
  signer: { keyId: string; privatePem: string },
  deps: DeliveryTransport,
  mode: DeliverMode,
): Promise<DeliveryOutcome> {
  const { handle, activityId, inbox, actorIds, body } = job
  const key = `${activityId}|${inbox}`

  const claim = await deps.ledger.claim(key)
  if (claim === 'inflight') {
    // Not 'done': the holder may have died (Lambda timeout / crash) after
    // claiming and before POSTing. Treating that as a duplicate would lose
    // the activity for this inbox for good (the stream batch / SQS message
    // would count as handled). Re-check after the lease can have expired; a
    // live holder finishing first just turns the re-check into a duplicate.
    console.warn(
      JSON.stringify({ at: 'ap.deliver', event: 'delivery_inflight_recheck', handle, activityId }),
    )
    if (mode === 'retry') {
      throw new RetryableDeliveryError(`delivery to ${inbox} is claimed by another attempt`)
    }
    await deps.retryQueue.enqueue(
      {
        kind: 'deliver',
        handle,
        activityId,
        inbox,
        actorIds,
        body: body.toString('utf8'),
      },
      INFLIGHT_RETRY_DELAY_SECONDS,
    )
    return 'retry_queued'
  }
  if (!claim) {
    console.log(
      JSON.stringify({ at: 'ap.deliver', event: 'delivery_duplicate_skipped', handle, activityId }),
    )
    return 'duplicate'
  }

  let status: number | undefined
  let failure: { message?: string; permanent?: boolean } | undefined
  try {
    const headers = await deps.signRequest({
      method: 'POST',
      url: inbox,
      body,
      keyId: signer.keyId,
      privateKeyPem: signer.privatePem,
    })
    status = (await deps.postFetch(inbox, { headers, body })).status
  } catch (e: any) {
    failure = { message: e?.message, permanent: e?.permanent === true }
  }

  if (status !== undefined && status >= 200 && status < 300) {
    await deps.ledger.complete(key, 'delivered')
    return 'delivered'
  }
  if (status === 410) {
    for (const id of actorIds) await deps.followers.remove(handle, id)
    await deps.ledger.complete(key, 'gone')
    console.log(
      JSON.stringify({ at: 'ap.deliver', event: 'follower_removed_410', handle, inbox }),
    )
    return 'gone'
  }

  const retryable = failure
    ? !failure.permanent
    : status !== undefined && isRetryableStatus(status)
  console.error(
    JSON.stringify({
      at: 'ap.deliver',
      event: retryable ? 'delivery_failed' : 'delivery_rejected',
      handle,
      actorId: actorIds[0],
      ...(status !== undefined ? { status } : {}),
      ...(failure ? { message: failure.message } : {}),
    }),
  )

  if (!retryable) {
    await deps.ledger.complete(key, 'rejected')
    return 'rejected'
  }

  // Release BEFORE queueing: if the queued retry is consumed while the claim
  // is still held it would be dropped as a duplicate.
  await deps.ledger.release(key)
  if (mode === 'retry') {
    throw new RetryableDeliveryError(
      `delivery to ${inbox} failed (${status ?? failure?.message})`,
    )
  }
  await deps.retryQueue.enqueue(
    {
      kind: 'deliver',
      handle,
      activityId,
      inbox,
      actorIds,
      body: body.toString('utf8'),
    },
    FIRST_RETRY_DELAY_SECONDS,
  )
  return 'retry_queued'
}

/**
 * Re-send a queued 'deliver' message (SQS retry consumer). Signing is redone
 * here so the Date header is fresh.
 */
export async function redeliver(
  msg: Extract<RetryMessage, { kind: 'deliver' }>,
  deps: DeliverDeps,
): Promise<DeliveryOutcome> {
  const origin = canonicalApOrigin(msg.handle, deps.customHosts ?? [])
  const { privatePem } = await deps.getApKey(msg.handle)
  return deliverOne(
    {
      handle: msg.handle,
      activityId: msg.activityId,
      inbox: msg.inbox,
      actorIds: msg.actorIds,
      body: Buffer.from(msg.body, 'utf8'),
    },
    { keyId: `${origin}/ap/users/${msg.handle}#main-key`, privatePem },
    deps,
    'retry',
  )
}

// ---------------------------------------------------------------------------
// AWS Lambda entrypoint
// ---------------------------------------------------------------------------

/**
 * Lambda handler for the DDB stream consumer.
 *
 * Real deps are constructed via makeDeliverDeps() from ../ap-deps.ts (outside
 * ap/** so the G2 cardinal-rule guard stays GREEN). Import is deferred
 * (dynamic) to keep the module pure/testable at the top level and to mirror
 * the existing handler.ts M2-cycle pattern.
 */
export async function handler(event: { Records: any[] }): Promise<void> {
  const { makeDeliverDeps } = await import('../ap-deps.js')
  const events = eventsFromStream(event)
  if (events.length === 0) return
  await processStream(events, makeDeliverDeps())
}
