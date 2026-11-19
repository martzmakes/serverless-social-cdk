/**
 * ap/handler.ts — ActivityPub bridge Lambda (Spec #7 / Phase C, Task 6).
 *
 * Exports two symbols (mirrors pds/handler.ts route()/handler() split):
 *   dispatch() — pure router. No APIGW types, no real AWS/network. Every
 *                external effect is an INJECTED dependency (ApDeps) so unit
 *                tests drive it with mocks.
 *   handler()  — APIGW HTTP API v2 entrypoint. Parses the raw event,
 *                constructs the real deps, calls dispatch().
 *
 * Surface owned by this Lambda (ADDITIVE — Task 9 routes only these here):
 *   GET  /.well-known/webfinger?resource=acct:<h>@serverless.social
 *   GET  /ap/users/<h>                 (Accept-negotiated actor)
 *   GET  /ap/users/<h>/outbox[?page]   (OrderedCollection / Page)
 *   GET  /ap/users/<h>/followers       (OrderedCollection of actor ids)
 *   POST /ap/users/<h>/inbox           (HTTP-Signature-verified Follow/Undo/Delete/Reject/Block)
 *   POST|DELETE|GET /ap/users/<h>/following, GET /ap/users/<h>/timeline
 *                                      (owner-authenticated; see handleOwnerRoute)
 *
 * CARDINAL RULE: this Lambda NEVER writes the AT repo / firehose / the apex
 * DID document /
 * the AT signing key. It only READS the repo (listOutbox) for the outbox.
 * AP followers live ONLY in ApFollowersTable. text/html on /ap/users/<h>
 * returns 406 (a non-actor passthrough signal) so the existing SPA/longform
 * routing is unaffected.
 *
 * ATTACKER-FACING: the inbox accepts requests from arbitrary remote servers.
 * Hardening lives in fetchRemoteActor (https-only, timeout, size cap,
 * redirect:'manual'), keyId/owner host binding, the digest-covered signature
 * check (httpsig enforces digest when signed), one forced key-rotation
 * refetch, and structured logging on every signature-fail before 401.
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda'

import { HANDLE, PDS_ENDPOINT } from '../pds/lexicons'
import { resolveTenant, type Tenant, type TenantStore } from '../pds/tenant'

import { buildWebfinger } from './webfinger'
import { buildActor, type ApProfile } from './actor'
import { canonicalApHost, canonicalApOrigin, pageOriginFor } from './host'
import {
  postToNote,
  longformToArticle,
  type AtPost,
  type AtLongform,
} from './translate'
import {
  buildOutbox,
  buildOutboxPage,
  type ApOutboxItem,
} from './outbox'
import {
  checkInboxSignaturePolicy,
  type verifyRequest,
  type signRequest,
} from './httpsig'
import {
  FIRST_RETRY_DELAY_SECONDS,
  isRetryableStatus,
  type RetryQueue,
} from './deliver'
// Real AWS/network-backed deps live OUTSIDE ap/** (cardinal-rule guard).
// M2: the handler<->ap-deps cycle is INTENTIONAL and effect-free at module
// scope — makeRealDeps() is only called inside handler()'s body, and the
// consts ap-deps imports back from here are plain top-level primitives. Do
// NOT move makeRealDeps() to module top level.
import { makeRealDeps } from '../ap-deps'
import {
  FollowResolveError,
  buildFollow,
  buildUndoFollow,
  followIdFor,
  ownerFollowingItem,
  parseAcct,
  publicFollowingCollection,
  resolveActorByAcct,
  type ApFollowingStore,
  type FetchJson,
  type FollowingRow,
} from './following'
import {
  CURSOR_RE,
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
  buildTimeline,
  ingestActivity,
  type ApInboundStore,
} from './ingest'

// ---------------------------------------------------------------------------
// AP-owned env keys (Task 9 wires the tables; ap-deps.ts reads them).
// ---------------------------------------------------------------------------

export const AP_ENV = {
  AP_FOLLOWERS_TABLE: 'AP_FOLLOWERS_TABLE',
  AP_ACTOR_CACHE_TABLE: 'AP_ACTOR_CACHE_TABLE',
  /** SQS delivery retry queue URL (Accept + ApDelivery producers, retry consumer). */
  AP_RETRY_QUEUE_URL: 'AP_RETRY_QUEUE_URL',
  /** Idempotency ledger table: one row per (activityId, inbox). */
  AP_LEDGER_TABLE: 'AP_LEDGER_TABLE',
  /** Outbound follows (pk=handle, sk=actorId). */
  AP_FOLLOWING_TABLE: 'AP_FOLLOWING_TABLE',
  /** Ingested posts from followees (pk=handle, sk=key, GSI byPublished, 90 d TTL). */
  AP_INBOUND_TABLE: 'AP_INBOUND_TABLE',
} as const

const ORIGIN = PDS_ENDPOINT // https://serverless.social
const APEX_DOMAIN = HANDLE // serverless.social

// Remote-fetch hardening constants (attacker-facing). Exported so the
// AWS-backed dep construction (../ap-deps.ts) shares the exact limits.
export const REMOTE_FETCH_TIMEOUT_MS = 5000
export const REMOTE_FETCH_MAX_BYTES = 256 * 1024 // 256 KB
export const ACTOR_CACHE_TTL_SECONDS = 24 * 60 * 60 // 1 day
/** Inbox body cap (Mastodon activities are a few KB; rejected before any crypto). */
export const INBOX_MAX_BODY_BYTES = 256 * 1024
/** Owner route JSON body cap. */
export const OWNER_MAX_BODY_BYTES = 4 * 1024

// ---------------------------------------------------------------------------
// Store interfaces (Task 9 supplies the CDK tables; dispatch depends only on
// these narrow shapes — tests inject mocks).
// ---------------------------------------------------------------------------

/** AP follower persistence. Row: pk=handle, sk=actorId, inbox (delivery URL). */
export interface ApFollowersStore {
  add(handle: string, actorId: string, inbox: string): Promise<void>
  remove(handle: string, actorId: string): Promise<void>
  list(handle: string): Promise<string[]>
}

/** TTL'd remote-actor signing-key cache. pk=actorId. */
export interface ApActorCache {
  get(
    actorId: string,
  ): Promise<{ publicKeyPem: string; inbox: string } | null>
  put(
    actorId: string,
    publicKeyPem: string,
    inbox: string,
    ttl?: number,
  ): Promise<void>
}

/** A fetched + validated remote actor (its own id, inbox, signing key). */
export interface RemoteActor {
  id: string
  inbox: string
  publicKeyPem: string
}

/** Injected dependency bundle — every external effect dispatch needs. */
export interface ApDeps {
  tenantStore: TenantStore
  /** Load (or mint) the local actor's AP RSA keypair for `handle`. */
  getApKey(
    handle: string,
  ): Promise<{ privatePem: string; publicPem: string }>
  verifyRequest: typeof verifyRequest
  signRequest: typeof signRequest
  /** Hardened https-only fetch+validate of the signing actor doc by keyId. */
  fetchRemoteActor(keyId: string): Promise<RemoteActor>
  /** POST a pre-signed activity body to a remote inbox. */
  deliverActivity(
    inboxUrl: string,
    body: Buffer,
    headers: Record<string, string>,
  ): Promise<void | { status: number }>
  followers: ApFollowersStore
  actorCache: ApActorCache
  /** Read the resolved tenant's outbox-eligible records. */
  listOutbox(
    did: string,
    cursor?: string,
  ): Promise<{
    /** `slug` is set on longform records: the slug the renderer published. */
    records: { uri: string; cid: string; value: unknown; slug?: string }[]
    cursor?: string
  }>
  /**
   * Exact number of outbox items (OrderedCollection.totalItems): Articles +
   * Notes, minus the renderer's syndication link posts (never double counted).
   */
  countOutbox(did: string): Promise<number>
  /** One post by rkey (point read), or null. */
  getOutboxPost(
    did: string,
    rkey: string,
  ): Promise<{ uri: string; cid: string; value: unknown } | null>
  /**
   * One PUBLISHED longform by rkey (record + the slug the renderer assigned),
   * or null when it is missing or not rendered yet. Backs the Article id.
   */
  getArticle?(
    did: string,
    rkey: string,
  ): Promise<{ record: AtLongform; slug: string } | null>
  /**
   * Retry queue for failed outbound deliveries (the Accept). Optional only so
   * tests can omit it; without it a failed Accept surfaces as a 500 and the
   * remote re-sends the Follow.
   */
  retryQueue?: RetryQueue
  /**
   * Hosts (handles) served from their own domain instead of the apex
   * (env AP_CUSTOM_HOSTS). Optional: omitted ⇒ everything is apex-hosted.
   */
  customHosts?: string[]
  /**
   * The tenant's AT app.bsky.actor.profile record (displayName, description,
   * avatar/banner CIDs), or null. Optional + best-effort: a throw or null
   * never fails the actor document.
   */
  getProfile?(did: string): Promise<ApProfile | null>
  /** Outbound follows. Unwired (tests) => /following stays the empty collection. */
  following?: ApFollowingStore
  /** Ingested posts from accepted followees. */
  inbound?: ApInboundStore
  /**
   * GET returning parsed JSON behind assertSafeRemoteUrl (https only, every
   * redirect hop re-guarded, size capped, timeout). Used for webfinger, actor
   * documents and Announce targets.
   */
  fetchJson?: FetchJson
  /**
   * Resolves an Authorization header to the DID of a first-party plain-Bearer
   * session (the token /auth/pds-session mints), or null. DPoP-bound tokens
   * never authenticate here.
   */
  authenticateOwner?(authorization: string | undefined): Promise<string | null>
}

// ---------------------------------------------------------------------------
// dispatch request / result
// ---------------------------------------------------------------------------

export interface ApRequest {
  method: string
  /** Pathname only (no query). */
  path: string
  query: Record<string, string>
  /** Lowercased header map. */
  headers: Record<string, string>
  /** Raw request body bytes (exact bytes the remote signed). */
  rawBody: Buffer
  /** Full request URL (used as outbox-page selfUrl + signing path). */
  url: string
}

export interface ApResult {
  status: number
  body: string
  contentType: string
  /** Extra response headers (CORS preflight, WWW-Authenticate). */
  headers?: Record<string, string>
}

const JRD = 'application/jrd+json'
const AS = 'application/activity+json'

function json(status: number, obj: unknown, contentType = AS): ApResult {
  return { status, body: JSON.stringify(obj), contentType }
}

function err(status: number, error: string, message?: string): ApResult {
  return {
    status,
    body: JSON.stringify(message ? { error, message } : { error }),
    contentType: 'application/json',
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True only for the AP content types we serve actor/collections to.
 *
 * POC LIMITATION M4: this is intentionally a loose substring match on the
 * Accept header (not a structured content-type/q-value parse). It is NOT the
 * security boundary — Task 9 CloudFront routing is the real gate that ensures
 * only /ap/* + webfinger ever reach this Lambda; this check only picks
 * actor-vs-passthrough for requests already routed here.
 */
function wantsActivityJson(accept: string | undefined): boolean {
  if (!accept) return false
  const a = accept.toLowerCase()
  return (
    a.includes('application/activity+json') ||
    a.includes('application/ld+json') ||
    // some implementations send a bare AS profile content type
    a.includes('profile="https://www.w3.org/ns/activitystreams"')
  )
}

/** Resolve `handle` (a serverless.social handle) to its active Tenant or null. */
async function resolveHandleTenant(
  handle: string,
  store: TenantStore,
): Promise<Tenant | null> {
  return resolveTenant({ handle }, store)
}

/**
 * Resolve the local-part of an `acct:` webfinger query to its Tenant.
 *
 * Accepts BOTH forms — the new canonical first-label form (matches the actor's
 * `preferredUsername` per Mastodon's validation rule) and the legacy full-handle
 * form (so previously-cached remote queries keep resolving):
 *
 *   acct:martzmakes@serverless.social      → tenant martzmakes.com (first-label)
 *   acct:martzmakes.com@serverless.social  → tenant martzmakes.com (full handle)
 *   acct:serverless@serverless.social      → apex (first-label)
 *   acct:serverless.social@serverless.social → apex (full handle, legacy)
 *
 * First-label resolution scans `listActive()` (O(N) tenant rows). Acceptable
 * for the current single-tenant + apex deployment; if sub-user count grows
 * meaningfully a `byFirstLabel` GSI would be the natural next step.
 *
 * First-label collision (e.g. martzmakes.com + martzmakes.serverless.social
 * both having label "martzmakes") is currently impossible by construction
 * (only one user, plus apex). If sub-user provisioning ever introduces such a
 * collision, the listActive scan returns the first DDB-ordered match — that
 * would need a reservation gate at provision time, not here.
 */
async function resolveByAcctName(
  acctName: string,
  store: TenantStore,
  acctDomain: string = APEX_DOMAIN,
  customHosts: string[] = [],
): Promise<Tenant | null> {
  // 0. Custom-host domain (e.g. martzmakes.com): ONLY that host's own tenant
  //    answers, by its first label or full handle. Nothing else (foo@host,
  //    apex names, other tenants' names) may resolve through a custom domain.
  if (acctDomain !== APEX_DOMAIN) {
    if (!customHosts.includes(acctDomain)) return null
    if (acctName !== acctDomain && acctName !== acctDomain.split('.')[0]) {
      return null
    }
    return resolveTenant({ handle: acctDomain }, store)
  }
  // 1. Apex special-case — both forms map to the apex tenant without a store hit.
  if (acctName === APEX_DOMAIN || acctName === APEX_DOMAIN.split('.')[0]) {
    return resolveTenant({ handle: APEX_DOMAIN }, store)
  }
  // 2. Legacy form: query treats the local-part as the full handle directly.
  const direct = await resolveTenant({ handle: acctName }, store)
  if (direct) return direct
  // 3. New canonical: treat the local-part as the first DNS label and scan
  //    active tenants for the one whose handle.split('.')[0] equals it.
  const all = await store.listActive()
  for (const row of all) {
    const t = await resolveTenant({ did: row.did }, store)
    if (t && t.handle.split('.')[0] === acctName) return t
  }
  return null
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).host
  } catch {
    return null
  }
}

/**
 * Inbox handler. Attacker-facing. Returns 202 on accept/ignore, 401 on a
 * signature failure (always after a structured log — carry-forward), 400 on
 * an unparseable body.
 *
 * Key-rotation: try the cached key first; on verify=false with a cached key,
 * force EXACTLY ONE refetch and re-verify. Still false → 401.
 */
async function handleInbox(
  handle: string,
  req: ApRequest,
  deps: ApDeps,
): Promise<ApResult> {
  if (req.rawBody.length > INBOX_MAX_BODY_BYTES) {
    console.warn(
      JSON.stringify({ at: 'ap.inbox', event: 'body_too_large', handle, bytes: req.rawBody.length }),
    )
    return err(413, 'PayloadTooLarge', 'Activity body too large')
  }
  const customHosts = deps.customHosts ?? []
  // Signing host = the ADDRESSED actor's canonical public host (derived from
  // the tenant handle, never from any request header).
  const pinnedHost = canonicalApHost(handle, customHosts)
  const origin = canonicalApOrigin(handle, customHosts)
  // The signed request-target path is the inbox pathname (+ any query).
  // We verify over the EXACT raw body bytes — never a re-serialized copy.
  const sigHeader = req.headers['signature']
  if (!sigHeader) {
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'signature_missing',
        handle,
        path: req.path,
      }),
    )
    return err(401, 'Unauthorized', 'Missing HTTP signature')
  }

  // INBOX POLICY (before any crypto/network): the signature must cover
  // (request-target) host date and - when there is a body - digest, and the
  // signed Date must be within the replay window. Without this a sender could
  // choose a header list that leaves the body or the timestamp unbound.
  // Extra signed headers (Mastodon's content-type) are fine; they are rebuilt
  // from the request verbatim.
  const policyFailure = checkInboxSignaturePolicy({
    signatureHeader: sigHeader,
    dateHeader: req.headers['date'],
    hasBody: req.rawBody.length > 0,
  })
  if (policyFailure) {
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'signature_policy_rejected',
        reason: policyFailure,
        handle,
        path: req.path,
      }),
    )
    return err(401, 'Unauthorized', 'Signature does not meet inbox requirements')
  }

  // Parse the keyId out of the Signature header (quoted draft-cavage param).
  const keyIdMatch = /keyId="([^"]+)"/.exec(sigHeader)
  const keyId = keyIdMatch?.[1]
  if (!keyId) {
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'signature_no_keyid',
        handle,
      }),
    )
    return err(401, 'Unauthorized', 'Malformed signature keyId')
  }

  // The keyId host MUST equal the fetched actor id host (anti-impersonation).
  // We first check the cache, then (if needed) fetch+validate. fetchRemoteActor
  // is responsible for the https-only / timeout / size-cap / owner==id checks;
  // here we additionally bind keyId host == actor id host.
  const keyIdHost = hostOf(keyId)
  if (!keyIdHost) {
    console.warn(
      JSON.stringify({ at: 'ap.inbox', event: 'keyid_unparseable', handle }),
    )
    return err(401, 'Unauthorized', 'Malformed signature keyId')
  }

  // Build the verify request once (path = request-target the remote signed).
  // CloudFront→API Gateway rewrites the inbound `Host` to the execute-api
  // origin domain, but a conformant remote signs draft-cavage `host:` as the
  // PUBLIC host it addressed (serverless.social). Verify against our canonical
  // public host, never the proxy-rewritten/attacker-influenced received Host.
  const verifyReq = {
    method: req.method,
    path: req.path,
    headers: { ...req.headers, host: pinnedHost },
    body: req.rawBody,
  }

  // Resolve the signing actor: cache → fetch. We track whether we used a
  // cached key so we can do ONE forced refetch on a verify miss.
  const cached = await deps.actorCache.get(keyIdHostActorId(keyId))
  let actorId: string
  let actorInbox: string
  let publicKeyPem: string
  let usedCache = false

  if (cached) {
    // I2: cache-path integrity DERIVES FROM THE COLD PATH — it is NOT
    // re-checked here, and the previous `hostOf(actorId) !== keyIdHost`
    // guard was dead code (tautologically true: actorId is exactly
    // keyIdHostActorId(keyId) = keyId minus #fragment, so it always shares
    // keyId's host by construction). The real invariant: this cache is ONLY
    // ever populated by fetchAndBind AFTER it validated
    // publicKey.owner===actor.id AND host(actor.id)===keyId host. So a cache
    // hit keyed on keyIdHostActorId(keyId) can only return a PEM previously
    // validated for exactly that id. The signature must STILL verify against
    // that PEM below, and a spoofed activity.actor !== actorId is still
    // rejected — so dropping the dead check changes no trust behavior.
    actorId = keyIdHostActorId(keyId)
    publicKeyPem = cached.publicKeyPem
    actorInbox = cached.inbox
    usedCache = true
  } else {
    const fetched = await fetchAndBind(keyId, keyIdHost, deps)
    if ('error' in fetched) return fetched.error
    actorId = fetched.actor.id
    actorInbox = fetched.actor.inbox
    publicKeyPem = fetched.actor.publicKeyPem
    await deps.actorCache.put(
      actorId,
      publicKeyPem,
      actorInbox,
      ACTOR_CACHE_TTL_SECONDS,
    )
  }

  let ok = await deps.verifyRequest(verifyReq, publicKeyPem)

  // Key rotation: cached key failed → ONE forced refetch + re-verify.
  if (!ok && usedCache) {
    const fetched = await fetchAndBind(keyId, keyIdHost, deps)
    if ('error' in fetched) return fetched.error
    actorId = fetched.actor.id
    actorInbox = fetched.actor.inbox
    publicKeyPem = fetched.actor.publicKeyPem
    await deps.actorCache.put(
      actorId,
      publicKeyPem,
      actorInbox,
      ACTOR_CACHE_TTL_SECONDS,
    )
    ok = await deps.verifyRequest(verifyReq, publicKeyPem)
  }

  if (!ok) {
    // CARRY-FORWARD: structured log on EVERY signature-fail before 401.
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'signature_verification_failed',
        handle,
        keyId,
        actorId,
        path: req.path,
      }),
    )
    return err(401, 'Unauthorized', 'Invalid HTTP signature')
  }

  // Parse a COPY of the body purely for activity dispatch (the bytes were
  // already verified above — never re-derive trust from this parse).
  let activity: any
  try {
    activity = JSON.parse(req.rawBody.toString('utf8'))
  } catch {
    return err(400, 'BadRequest', 'Unparseable activity body')
  }

  const type = typeof activity?.type === 'string' ? activity.type : ''

  // Defense: the signing actor must be the activity actor (no spoofed actor).
  const activityActor =
    typeof activity?.actor === 'string'
      ? activity.actor
      : activity?.actor?.id
  if (activityActor && activityActor !== actorId) {
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'actor_signer_mismatch',
        handle,
        activityActor,
        actorId,
      }),
    )
    return err(401, 'Unauthorized', 'Activity actor does not match signer')
  }

  // One structured line per accepted (verified) activity: type + actor host
  // only - never the content. `type` is attacker-chosen text: clamp it.
  console.log(
    JSON.stringify({
      at: 'ap.inbox',
      event: 'activity_accepted',
      type: type.replace(/[^A-Za-z]/g, '').slice(0, 32) || 'unknown',
      actorHost: hostOf(actorId),
      handle,
    }),
  )

  const objectId = (o: unknown): string | undefined =>
    typeof o === 'string'
      ? o
      : o && typeof o === 'object' && typeof (o as any).id === 'string'
        ? (o as any).id
        : undefined
  const ourActorId = `${origin}/ap/users/${handle}`

  if (type === 'Follow') {
    await deps.followers.add(handle, actorId, actorInbox)
    await sendAccept(handle, origin, activity, actorId, actorInbox, deps)
    return json(202, { status: 'accepted' })
  }

  if (type === 'Undo') {
    const inner = activity?.object
    const innerType =
      typeof inner === 'object' && inner ? inner.type : undefined
    if (innerType === 'Follow') {
      await deps.followers.remove(handle, actorId)
    }
    // Undo of anything else: 202 ignore (no oracle).
    return json(202, { status: 'accepted' })
  }

  // Delete of the signer itself (account deletion), a Reject, or a Block aimed
  // at us all end the relationship: drop the signer's follower row. Only the
  // verified signer's own row can be touched (actorId == signer, checked above).
  if (type === 'Delete' && objectId(activity?.object) === actorId) {
    await deps.followers.remove(handle, actorId)
    await deps.following?.remove(handle, actorId)
    return json(202, { status: 'accepted' })
  }
  if (type === 'Reject') {
    await deps.followers.remove(handle, actorId)
    // A Reject of OUR Follow ends the pending/accepted follow too.
    await deps.following?.remove(handle, actorId)
    return json(202, { status: 'accepted' })
  }

  // Accept of our Follow: only the followee itself (signer == row key) can
  // flip its own pending row; it must name our Follow id when it names one.
  if (type === 'Accept' && deps.following) {
    const row = await deps.following.get(handle, actorId)
    const named = objectId(activity?.object)
    if (row && (!named || named === row.followId)) {
      await deps.following.setAccepted(handle, actorId)
    }
    return json(202, { status: 'accepted' })
  }

  // Posts from people we follow. Everything is gated on an accepted
  // following row inside ingestActivity; Delete is author-scoped.
  if (
    (type === 'Create' || type === 'Update' || type === 'Delete' || type === 'Announce') &&
    deps.following &&
    deps.inbound &&
    deps.fetchJson
  ) {
    if (activityActor !== actorId) {
      // ingest requires an explicit actor (the generic check lets it be absent)
      return err(401, 'Unauthorized', 'Activity actor does not match signer')
    }
    const followee = await deps.following.get(handle, actorId)
    const outcome = await ingestActivity(type, activity, {
      handle,
      signerId: actorId,
      followee,
      store: deps.inbound,
      fetchJson: deps.fetchJson,
    })
    return json(202, { status: outcome === 'ignored' ? 'ignored' : 'accepted' })
  }
  if (type === 'Block' && objectId(activity?.object) === ourActorId) {
    await deps.followers.remove(handle, actorId)
    return json(202, { status: 'accepted' })
  }

  // Unknown activity type → 202 + ignore. No write, no error body leak.
  return json(202, { status: 'ignored' })
}

/** Cache key for a keyId == the actor id (keyId minus the #fragment). */
function keyIdHostActorId(keyId: string): string {
  const hash = keyId.indexOf('#')
  return hash >= 0 ? keyId.slice(0, hash) : keyId
}

/**
 * Fetch the remote actor for `keyId` and bind keyId host == actor id host ==
 * publicKey owner host. Returns the validated actor or an error ApResult.
 */
async function fetchAndBind(
  keyId: string,
  keyIdHost: string,
  deps: ApDeps,
): Promise<{ actor: RemoteActor } | { error: ApResult }> {
  let actor: RemoteActor
  try {
    actor = await deps.fetchRemoteActor(keyId)
  } catch (e: any) {
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'remote_actor_fetch_failed',
        keyId,
        message: e?.message,
      }),
    )
    return { error: err(401, 'Unauthorized', 'Could not resolve signer') }
  }
  const idHost = hostOf(actor.id)
  if (!idHost || idHost !== keyIdHost) {
    console.warn(
      JSON.stringify({
        at: 'ap.inbox',
        event: 'keyid_host_mismatch',
        keyId,
        actorId: actor.id,
      }),
    )
    return { error: err(401, 'Unauthorized', 'keyId host mismatch') }
  }
  return { actor }
}

/**
 * Build + sign + deliver an Accept of the inbound Follow.
 */
async function sendAccept(
  handle: string,
  origin: string,
  follow: any,
  followerActorId: string,
  followerInbox: string,
  deps: ApDeps,
): Promise<void> {
  const actorId = `${origin}/ap/users/${handle}`
  const accept = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorId}#accepts/${encodeURIComponent(
      String(follow?.id ?? 'follow'),
    )}`,
    type: 'Accept',
    actor: actorId,
    object: follow,
  }
  await sendActivity(handle, origin, accept, followerInbox, [followerActorId], deps, 'accept')
}

/**
 * Sign + deliver one activity from `handle`'s actor. A transient failure (5xx,
 * 429/408, network) is routed through the SQS retry queue (re-signed at send
 * time); a permanent refusal is logged and dropped. If there is no queue the
 * error propagates (500) and the remote re-sends the Follow / the owner retries.
 *
 * `actorIds` are the follower rows the retry path removes on a 410. Outbound
 * Follow/Undo pass [] (a gone followee must not touch the followers table).
 * `label` only names the structured log events.
 */
async function sendActivity(
  handle: string,
  origin: string,
  activity: { id: string },
  inbox: string,
  actorIds: string[],
  deps: ApDeps,
  label: string,
): Promise<void> {
  const actorId = `${origin}/ap/users/${handle}`
  const bodyText = JSON.stringify(activity)
  const body = Buffer.from(bodyText, 'utf8')
  try {
    const { privatePem } = await deps.getApKey(handle)
    const headers = await deps.signRequest({
      method: 'POST',
      url: inbox,
      body,
      keyId: `${actorId}#main-key`,
      privateKeyPem: privatePem,
    })
    const res = await deps.deliverActivity(inbox, body, headers)
    if (res && typeof res.status === 'number') {
      if (isRetryableStatus(res.status)) {
        throw new Error(`${label} delivery status ${res.status}`)
      }
      if (res.status < 200 || res.status >= 300) {
        console.error(
          JSON.stringify({
            at: 'ap.inbox',
            event: `${label}_rejected`,
            handle,
            status: res.status,
          }),
        )
      }
    }
  } catch (e: any) {
    if (e?.permanent) {
      console.error(
        JSON.stringify({ at: 'ap.inbox', event: `${label}_rejected`, handle, message: e?.message }),
      )
      return
    }
    console.error(
      JSON.stringify({ at: 'ap.inbox', event: `${label}_failed`, handle, message: e?.message }),
    )
    if (!deps.retryQueue) throw e
    await deps.retryQueue.enqueue(
      {
        kind: 'deliver',
        handle,
        activityId: activity.id,
        inbox,
        actorIds,
        body: bodyText,
      },
      FIRST_RETRY_DELAY_SECONDS,
    )
  }
}

// ---------------------------------------------------------------------------
// Owner routes: /following (POST/DELETE/GET) and /timeline (GET)
//
// AUTH: a first-party plain-Bearer session whose DID equals the addressed
// tenant's DID. A non-owner, a missing/invalid token and an unknown tenant all
// get 401: CloudFront rewrites 403 AND 404 on this distribution into a 200
// HTML shell (SPA fallback), which would hide the failure from API clients.
// Expected failures therefore use 400 / 401 / 413 / 422 only.
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '600',
}

function unauthorized(): ApResult {
  return {
    ...err(401, 'Unauthorized', 'Owner authentication required'),
    headers: { 'www-authenticate': 'Bearer' },
  }
}

async function isOwner(req: ApRequest, tenant: Tenant | null, deps: ApDeps): Promise<boolean> {
  if (!tenant || !deps.authenticateOwner) return false
  try {
    const did = await deps.authenticateOwner(req.headers['authorization'])
    return !!did && did === tenant.did
  } catch {
    return false
  }
}

function parseOwnerBody(req: ApRequest): { value: any } | { error: ApResult } {
  if (req.rawBody.length > OWNER_MAX_BODY_BYTES) {
    return { error: err(413, 'PayloadTooLarge', 'Request body too large') }
  }
  try {
    const value = JSON.parse(req.rawBody.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return { value }
  } catch {
    return { error: err(400, 'BadRequest', 'Body must be a JSON object') }
  }
}

async function handleOwnerRoute(
  handle: string,
  sub: string,
  req: ApRequest,
  deps: ApDeps,
): Promise<ApResult> {
  const { method } = req
  if (method === 'OPTIONS') return { status: 204, body: '', contentType: 'text/plain', headers: CORS_HEADERS }

  const tenant = await resolveHandleTenant(handle, deps.tenantStore)
  const customHosts = deps.customHosts ?? []

  // GET /following without credentials: the public collection (accepted only).
  if (method === 'GET' && sub === '/following' && !req.headers['authorization']) {
    if (!tenant) return err(404, 'NotFound', 'No such actor')
    const actorId = `${canonicalApOrigin(tenant.handle, customHosts)}/ap/users/${tenant.handle}`
    const rows = deps.following ? await deps.following.list(tenant.handle) : []
    return json(200, publicFollowingCollection(actorId, rows), AS)
  }

  if (!(await isOwner(req, tenant, deps))) return unauthorized()
  if (!deps.following || !deps.inbound || !deps.fetchJson) {
    return err(501, 'NotImplemented', 'Following is not enabled')
  }
  const t = tenant!
  const origin = canonicalApOrigin(t.handle, customHosts)
  const ourActorId = `${origin}/ap/users/${t.handle}`

  if (sub === '/timeline') {
    if (method !== 'GET') return err(405, 'MethodNotAllowed', 'Method not allowed')
    const cursor = req.query.cursor
    if (cursor !== undefined && !CURSOR_RE.test(cursor)) return err(400, 'BadRequest', 'Invalid cursor')
    const n = Number.parseInt(req.query.limit ?? '', 10)
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_TIMELINE_LIMIT) : DEFAULT_TIMELINE_LIMIT
    const rows = await deps.following.list(t.handle)
    return json(200, await buildTimeline(t.handle, deps.inbound, rows, cursor, limit), 'application/json')
  }

  if (method === 'GET') {
    const rows = await deps.following.list(t.handle)
    return json(200, { items: rows.map(ownerFollowingItem) }, 'application/json')
  }

  if (method === 'POST') {
    const body = parseOwnerBody(req)
    if ('error' in body) return body.error
    const acct = parseAcct(body.value.acct)
    if (!acct) return err(400, 'BadRequest', 'acct must look like user@domain')
    const ownHosts = [APEX_DOMAIN, ...customHosts]
    let target
    try {
      target = await resolveActorByAcct(acct, deps.fetchJson, ownHosts)
    } catch (e: any) {
      if (!(e instanceof FollowResolveError)) {
        console.warn(JSON.stringify({ at: 'ap.follow', event: 'resolve_error', message: e?.message }))
      }
      // 422, not 404: CloudFront would rewrite a 404 into the SPA shell.
      return err(422, 'UnresolvableAccount', e instanceof FollowResolveError ? e.message : 'Could not resolve account')
    }
    const existing = await deps.following.get(t.handle, target.actorId)
    if (existing?.state === 'accepted') {
      return json(200, ownerFollowingItem(existing), 'application/json')
    }
    const followId = followIdFor(ourActorId, target.actorId)
    const row: FollowingRow = existing ?? {
      actorId: target.actorId,
      inbox: target.inbox,
      followId,
      state: 'pending',
      acct: target.acct,
      name: target.name,
      icon: target.icon,
      followers: target.followers,
      createdAt: Date.now(),
    }
    // Row first: the Accept can race our own response.
    if (!existing) await deps.following.put(t.handle, row)
    await sendActivity(
      t.handle,
      origin,
      buildFollow(ourActorId, row.followId, target.actorId),
      row.inbox,
      [],
      deps,
      'follow',
    )
    return json(existing ? 200 : 201, ownerFollowingItem(row), 'application/json')
  }

  if (method === 'DELETE') {
    let actor: string | undefined
    const m = /^\/following\/([^/]+)$/.exec(sub)
    try {
      actor = m ? decodeURIComponent(m[1]) : req.query.actor
    } catch {
      return err(400, 'BadRequest', 'Malformed actor id')
    }
    if (!actor) return err(400, 'BadRequest', 'Missing actor id')
    const row = await deps.following.get(t.handle, actor)
    if (row) {
      await sendActivity(
        t.handle,
        origin,
        buildUndoFollow(ourActorId, row.followId, row.actorId),
        row.inbox,
        [],
        deps,
        'unfollow',
      )
      await deps.following.remove(t.handle, row.actorId)
    }
    // Idempotent: unfollowing someone we do not follow is 200 (not 404).
    return json(200, { status: 'ok' }, 'application/json')
  }

  return err(405, 'MethodNotAllowed', 'Method not allowed')
}

// ---------------------------------------------------------------------------
// Pure router
// ---------------------------------------------------------------------------

export async function dispatch(
  req: ApRequest,
  deps: ApDeps,
): Promise<ApResult> {
  try {
    const { method, path } = req

    // ── GET /.well-known/webfinger ────────────────────────────────────────
    if (method === 'GET' && path === '/.well-known/webfinger') {
      const resource = req.query.resource
      if (!resource) {
        return err(400, 'BadRequest', 'Missing resource parameter')
      }
      // Expected: acct:<handle>@serverless.social
      const m = /^acct:([^@]+)@(.+)$/.exec(resource)
      if (!m) {
        return err(400, 'BadRequest', 'Malformed resource')
      }
      const acctHandle = m[1]
      const acctDomain = m[2]
      const customHosts = deps.customHosts ?? []
      if (acctDomain !== APEX_DOMAIN && !customHosts.includes(acctDomain)) {
        // A resource for a foreign domain — we are not authoritative.
        return err(404, 'NotFound', 'Resource not found')
      }
      const tenant = await resolveByAcctName(
        acctHandle,
        deps.tenantStore,
        acctDomain,
        customHosts,
      )
      if (!tenant) {
        return err(404, 'NotFound', 'Resource not found')
      }
      // Old and new acct forms both answer with the tenant's CANONICAL
      // subject + self link (Mastodon's username@domain round trip).
      return json(
        200,
        buildWebfinger(
          tenant.handle,
          canonicalApOrigin(tenant.handle, customHosts),
          canonicalApHost(tenant.handle, customHosts),
        ),
        JRD,
      )
    }

    // ── /ap/users/<handle>[/...] ──────────────────────────────────────────
    const apMatch = /^\/ap\/users\/([^/]+)(\/.*)?$/.exec(path)
    if (apMatch) {
      const handle = decodeURIComponent(apMatch[1])
      const sub = apMatch[2] ?? ''

      // Owner-authenticated following + timeline (+ the public /following GET).
      if (/^\/(following(\/[^/]+)?|timeline)$/.test(sub)) {
        return await handleOwnerRoute(handle, sub, req, deps)
      }

      // POST .../inbox — signed Follow/Undo
      if (method === 'POST' && sub === '/inbox') {
        const tenant = await resolveHandleTenant(handle, deps.tenantStore)
        if (!tenant) return err(404, 'NotFound', 'No such actor')
        // `await` so a throw is caught below (clean 500) instead of escaping as
        // a rejected promise out of the try.
        return await handleInbox(tenant.handle, req, deps)
      }

      // All remaining routes are GET only.
      if (method !== 'GET') {
        return err(405, 'MethodNotAllowed', 'Method not allowed')
      }

      const tenant = await resolveHandleTenant(handle, deps.tenantStore)
      if (!tenant) return err(404, 'NotFound', 'No such actor')
      // Every generated URL uses the tenant's canonical origin, whichever
      // host (old serverless.social URL or custom domain) the request used.
      const customHosts = deps.customHosts ?? []
      const origin = canonicalApOrigin(tenant.handle, customHosts)

      // GET /ap/users/<h> — the actor (content-negotiated)
      if (sub === '') {
        if (!wantsActivityJson(req.headers['accept'])) {
          // text/html (or anything non-AP): NON-actor passthrough signal.
          // 406 keeps the SPA/longform routing path entirely untouched —
          // Task 9 ensures CloudFront only routes /ap/* + webfinger here.
          return {
            status: 406,
            body: JSON.stringify({
              error: 'NotAcceptable',
              message:
                'This endpoint serves application/activity+json only',
            }),
            contentType: 'application/json',
          }
        }
        const { publicPem } = await deps.getApKey(tenant.handle)
        let profile: ApProfile | null = null
        try {
          profile = (await deps.getProfile?.(tenant.did)) ?? null
        } catch (e: any) {
          console.warn(
            JSON.stringify({
              at: 'ap.actor',
              event: 'profile_fetch_failed',
              handle: tenant.handle,
              message: e?.message,
            }),
          )
        }
        const isCustom = origin !== ORIGIN
        return json(
          200,
          buildActor(
            { did: tenant.did, handle: tenant.handle },
            publicPem,
            origin,
            {
              profile,
              blobOrigin: ORIGIN,
              ...(isCustom ? { profileUrl: `${origin}/` } : {}),
            },
          ),
          AS,
        )
      }

      const actorId = `${origin}/ap/users/${tenant.handle}`

      // GET /ap/users/<h>/outbox[?page=...]
      if (sub === '/outbox') {
        const isPage = req.query.page !== undefined
        if (!isPage) {
          const total = await deps.countOutbox(tenant.did)
          const firstPage = `${actorId}/outbox?page=true`
          return json(200, buildOutbox(actorId, total, firstPage), AS)
        }
        const cursorIn =
          req.query.page && req.query.page !== 'true'
            ? req.query.page
            : undefined
        const { records, cursor } = await deps.listOutbox(
          tenant.did,
          cursorIn,
        )
        const items: ApOutboxItem[] = []
        for (const r of records) {
          const rkey = r.uri.split('/').pop() ?? ''
          const collection = r.uri.split('/').slice(-2, -1)[0] ?? ''
          if (collection === 'social.serverless.longform') {
            // No slug = the renderer has not published a page: never emit an
            // Article whose url would 404 (listOutbox already filters these).
            if (!r.slug) continue
            items.push(
              longformToArticle({
                rkey,
                record: r.value as AtLongform,
                handle: tenant.handle,
                origin,
                pageOrigin: pageOriginFor(tenant.handle),
                slug: r.slug,
              }),
            )
          } else {
            items.push(
              postToNote({
                rkey,
                record: r.value as AtPost,
                handle: tenant.handle,
                origin,
              }),
            )
          }
        }
        // selfUrl = the real request URL, re-based onto the canonical origin
        // for custom-host tenants (apex/sub-user: req.url unchanged).
        let selfUrl = req.url
        if (origin !== ORIGIN) {
          let search = ''
          try {
            search = new URL(req.url).search
          } catch {
            /* keep empty */
          }
          selfUrl = `${origin}${req.path}${search}`
        }
        // selfUrl = the real request URL (Task 5 seam — page self-identifies).
        return json(
          200,
          buildOutboxPage(actorId, items, cursor, selfUrl),
          AS,
        )
      }

      // GET /ap/users/<h>/posts/<rkey> — the Note itself (dereferenceable id)
      const postMatch = /^\/posts\/([^/]+)$/.exec(sub)
      if (postMatch) {
        let rkey: string
        try {
          rkey = decodeURIComponent(postMatch[1])
        } catch {
          return err(404, 'NotFound', 'No such post')
        }
        const rec = await deps.getOutboxPost(tenant.did, rkey)
        if (!rec) return err(404, 'NotFound', 'No such post')
        const note = postToNote({
          rkey,
          record: rec.value as AtPost,
          handle: tenant.handle,
          origin,
        })
        return json(
          200,
          { '@context': 'https://www.w3.org/ns/activitystreams', ...note },
          AS,
        )
      }

      // GET /ap/users/<h>/articles/<rkey> - the Article itself (its AP id).
      // 404 until the renderer has published the page (url would not exist).
      const articleMatch = /^\/articles\/([^/]+)$/.exec(sub)
      if (articleMatch) {
        let rkey: string
        try {
          rkey = decodeURIComponent(articleMatch[1])
        } catch {
          return err(404, 'NotFound', 'No such article')
        }
        const art = (await deps.getArticle?.(tenant.did, rkey)) ?? null
        if (!art) return err(404, 'NotFound', 'No such article')
        return json(
          200,
          {
            '@context': 'https://www.w3.org/ns/activitystreams',
            ...longformToArticle({
              rkey,
              record: art.record,
              handle: tenant.handle,
              origin,
              pageOrigin: pageOriginFor(tenant.handle),
              slug: art.slug,
            }),
          },
          AS,
        )
      }

      // GET /ap/users/<h>/followers
      if (sub === '/followers') {
        const ids = await deps.followers.list(tenant.handle)
        return json(
          200,
          {
            '@context': 'https://www.w3.org/ns/activitystreams',
            type: 'OrderedCollection',
            id: `${actorId}/followers`,
            totalItems: ids.length,
            orderedItems: ids,
          },
          AS,
        )
      }

      return err(404, 'NotFound', 'No such AP resource')
    }

    return err(404, 'NotFound', 'Not found')
  } catch (e: any) {
    // Never leak internals to a remote caller; log server-side only.
    console.error(
      JSON.stringify({
        at: 'ap.dispatch',
        event: 'unhandled_error',
        path: req.path,
        message: e?.message,
        stack: e?.stack,
      }),
    )
    return err(500, 'InternalError', 'An unexpected error occurred')
  }
}

// ---------------------------------------------------------------------------
// APIGW HTTP API v2 entrypoint
//
// Real AWS/network deps are constructed in ../ap-deps.ts (kept OUTSIDE the
// ap/** tree so the apex-nonregression cardinal-rule guard — which forbids
// ap/** importing ../pds/storage — stays GREEN).
// ---------------------------------------------------------------------------

export const handler = async (event: APIGatewayProxyEventV2) => {
  const method = event.requestContext.http.method
  const rawPath = event.rawPath || ''

  const query: Record<string, string> = {}
  if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v !== undefined) query[k] = v
    }
  }

  const headers: Record<string, string> = {}
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      if (v !== undefined) headers[k.toLowerCase()] = v
    }
  }

  // Raw body bytes — the digest/signature is verified over THESE exact bytes.
  let rawBody = Buffer.alloc(0)
  if (event.body) {
    rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'utf8')
  }

  const url = `${ORIGIN}${rawPath}${
    event.rawQueryString ? `?${event.rawQueryString}` : ''
  }`

  const result = await dispatch(
    { method, path: rawPath, query, headers, rawBody, url },
    makeRealDeps(),
  )

  return {
    statusCode: result.status,
    headers: { 'content-type': result.contentType, ...(result.headers ?? {}) },
    body: result.body,
  }
}
