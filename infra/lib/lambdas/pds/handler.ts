/**
 * handler.ts — XRPC Lambda entrypoint for the AT Protocol PDS.
 *
 * Exports two symbols:
 *   route()   — pure router (no APIGW types), fully unit-testable.
 *   handler() — APIGW HTTP API v2 entrypoint; parses the raw event, extracts
 *               auth, calls route(), and returns the APIGW response shape.
 *
 * Route table:
 *   com.atproto.server.describeServer   GET  no-auth → identity
 *   com.atproto.identity.resolveHandle  GET  no-auth → identity
 *   com.atproto.server.createSession    POST no-auth → session (single-tenant auth)
 *   com.atproto.server.getSession       GET  auth    → session
 *   com.atproto.server.refreshSession   POST no-auth → session (refresh JWT in body)
 *   com.atproto.repo.createRecord       POST auth    → repo-write
 *   com.atproto.repo.putRecord          POST auth    → repo-write
 *   com.atproto.repo.deleteRecord       POST auth    → repo-write
 *   com.atproto.repo.getRecord          GET  no-auth → repo-read (getRecord lives in repo-write.ts)
 *   com.atproto.repo.listRecords        GET  no-auth → repo-read
 *   com.atproto.repo.describeRepo       GET  no-auth → repo-read
 *   com.atproto.sync.getRepo            GET  no-auth → sync (binary CAR)
 *   com.atproto.sync.getLatestCommit    GET  no-auth → sync
 *   com.atproto.sync.listRepos          GET  no-auth → sync
 *   com.atproto.sync.listBlobs          GET  no-auth → sync (blob cids)
 *
 * Well-known routes (handled in handler() directly):
 *   GET /.well-known/did.json     → DID document (JSON) — apex only (did:web;
 *                                   did:plc tenants have no did.json here, by
 *                                   design — see identity.ts)
 *   GET /.well-known/atproto-did  → plain-text DID, host-aware: resolves the
 *                                   request Host to a Tenant via
 *                                   tenant.ts:resolveTenantByHost() (same
 *                                   TenantStore lookup resolveHandle uses),
 *                                   falling back to the apex DID for
 *                                   serverless.social or any unrecognized host
 *
 * com.atproto.server.describeServer is similarly host-aware for
 * `availableUserDomains` (via resolveTenantByHost()), but `did` always stays
 * the apex PDS service DID (did:web:serverless.social) — that's the PDS's own
 * identity, not the caller's; a did:plc tenant's DID document already points
 * its `pds` service endpoint at this same host, so returning the PDS's own
 * did here is spec-correct for every tenant, not a bug.
 *
 * Error mapping (xrpcError → HTTP status):
 *   InvalidRequest  → 400
 *   AuthRequired    → 401
 *   RecordNotFound  → 400  (spec: a named XRPC error, not an HTTP-404 — kept
 *                           off 404 deliberately so CloudFront's SPA-fallback
 *                           errorResponses (404/403 → index.html) never
 *                           swallows a cross-origin XRPC error into an HTML
 *                           200 with no CORS headers)
 *   RepoNotFound    → 400  (spec: treat as client error — did not exist)
 *   anything else   → 500
 *   generic throws  → 500 (no stack leak)
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { S3Client } from '@aws-sdk/client-s3'
import { putBlob, getBlob } from './blobs'

import { DID, HANDLE, ENV } from './lexicons'
import { didDocument, describeServerFor } from './identity'
import { makeSession, verifyRefresh, verifyAppPassword } from './session'
import { verifyXrpcAuth } from './access-verify'
import { makeXrpcSeenJti } from './xrpc-jti'
import { getSigningKey } from './signing-key'
import { DynamoRepoStorage } from './storage'
import { APEX_DID } from './tenant-keys'
import { resolveTenant, resolveTenantByHost, type TenantStore } from './tenant'
import type { Secp256k1Keypair } from '@atproto/crypto'
import { createRecord, putRecord, deleteRecord, getRecord } from './repo-write'
import { listRecords, describeRepo } from './repo-read'
import { collectRepoBlobCids } from './list-blobs'
import { getRepoCar, getLatestCommit, listRepos } from './sync'
import { proxyAppView, serviceAuthJwt } from './appview-proxy'
import { verifyJwt } from '../auth/lib/jwt'
import { analyticsRead } from '../analytics/read'
import { parseCustomHosts } from '../ap/host'

// ---------------------------------------------------------------------------
// JWT secret — cached module-level (mirrors auth/lib/jwt.ts pattern)
// ---------------------------------------------------------------------------

const ssm = new SSMClient({})
let cachedJwtSecret: Uint8Array | null = null

async function getJwtSecret(): Promise<Uint8Array> {
  if (cachedJwtSecret) return cachedJwtSecret
  const res = await ssm.send(
    new GetParameterCommand({
      Name: process.env[ENV.JWT_SECRET_PARAM]!,
      WithDecryption: true,
    }),
  )
  const value = res.Parameter?.Value
  if (!value) throw new Error('JWT secret SSM param is empty')
  cachedJwtSecret = new TextEncoder().encode(value)
  return cachedJwtSecret
}

// ---------------------------------------------------------------------------
// Error status mapping
// ---------------------------------------------------------------------------

function xrpcErrorStatus(code: string): number {
  switch (code) {
    case 'InvalidRequest':  return 400
    case 'AuthRequired':    return 401
    // 400, not 404 — see the file-level doc comment: this keeps XRPC
    // "not found" errors off the HTTP status CloudFront's SPA-fallback
    // errorResponses intercepts, so a cross-origin caller (e.g. the
    // martzmakes.com SPA calling serverless.social) always sees the real
    // JSON {error:'RecordNotFound'} body + CORS headers instead of a
    // same-origin-only HTML 200 shell.
    case 'RecordNotFound':  return 400
    case 'RepoNotFound':    return 400
    default:                return 500
  }
}

// ---------------------------------------------------------------------------
// Route response type
// ---------------------------------------------------------------------------

export type RouteResult = {
  status: number
  body: string
  contentType?: string
  isBase64Encoded?: boolean
}

function jsonOk(obj: unknown): RouteResult {
  return { status: 200, body: JSON.stringify(obj), contentType: 'application/json' }
}

function jsonErr(status: number, error: string, message?: string): RouteResult {
  return {
    status,
    body: JSON.stringify(message ? { error, message } : { error }),
    contentType: 'application/json',
  }
}

function authRequired(): RouteResult {
  return jsonErr(401, 'AuthRequired', 'Authentication required')
}

// ---------------------------------------------------------------------------
// Storage + keypair + S3 factories (lazy per-invocation; module-level is warm)
// ---------------------------------------------------------------------------

function makeStorage(did: string): DynamoRepoStorage {
  return new DynamoRepoStorage(
    new DynamoDBClient({}),
    process.env[ENV.REPO_TABLE]!,
    did,
  )
}

function makeS3(): S3Client {
  return new S3Client({})
}

async function makeSigningKey() {
  return getSigningKey(process.env[ENV.SIGNING_KEY_PARAM]!)
}

// ---------------------------------------------------------------------------
// Inline TenantStore backed by TenantsTable (DDB GetCommand + QueryCommand)
// Apex short-circuits in resolveTenant() before any DDB call is made.
// ---------------------------------------------------------------------------

// D2: xrpc DPoP jti-replay guard. Reuses the existing @aws-sdk/lib-dynamodb
// DocumentClient (no new dep) against the SAME OAuth replay-guard table as the
// token endpoint's OAuthStore, so xrpc + token share one jti namespace.
// Apex/first-party plain-Bearer tokens have NO `cnf.jkt` and so never reach
// this port (access-verify.ts:~28-33) — wiring it is byte-identical for apex.
function makeXrpcSeenJtiPort(): (jti: string) => Promise<boolean> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  // Env key 'OAUTH_TABLE' mirrors infra-stack.ts (line ~170) and the
  // atproto-oauth handler's `process.env.OAUTH_TABLE` — the SAME physical
  // OAuthTable, so xrpc + the token endpoint share one jti namespace.
  return makeXrpcSeenJti(ddb, process.env.OAUTH_TABLE!)
}

function makeTenantStore(): TenantStore {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env[ENV.TENANTS_TABLE]!
  return {
    async byDid(did: string) {
      const res = await ddb.send(new GetCommand({ TableName: table, Key: { did } }))
      return res.Item ?? null
    },
    async byHandle(handle: string) {
      const res = await ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'byHandle',
        KeyConditionExpression: 'handle = :h',
        ExpressionAttributeValues: { ':h': handle },
        Limit: 1,
      }))
      return res.Items?.[0] ?? null
    },
    async listActive() {
      const res = await ddb.send(new ScanCommand({
        TableName: table,
        FilterExpression: '#s = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':a': 'active' },
      }))
      return (res.Items ?? []) as Array<{ did: string }>
    },
  }
}

// ---------------------------------------------------------------------------
// Helper: which viewer-facing domain is this request actually for?
//
// CAUTION (documented for the infra/CDK stream — see the workstream's
// requestsForOtherStreams, NOT fixable from this file alone): CloudFront's
// `apiBehavior` (infra-stack.ts, shared byte-identically between the
// serverless.social SiteDistribution and the martzmakes.com
// MartzmakesDistribution) uses `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`
// against a SINGLE shared HttpOrigin (the bare execute-api domain, no custom
// domain mapping) — confirmed live via `aws lambda list-event-source-mappings`/
// `aws apigatewayv2 get-apis` during this task. That means the *real* Host
// header (`serverless.social` vs `martzmakes.com`) is stripped before this
// Lambda ever sees it; `event.headers.host` here is always the shared
// execute-api domain, identical for both distributions.
//
// This function therefore checks `x-pds-viewer-host` FIRST — a header the
// infra stream still needs to add (e.g. distinct `customHeaders` on two
// cloned per-distribution origins, mirroring the existing
// `firehoseBoxOrigin` `X-PDS-Instance` precedent) — and falls back to the
// literal `host` header for direct/test callers that do supply it. Until
// that infra change ships, every production request resolves via the `host`
// fallback to the shared execute-api domain, which matches no tenant handle,
// so `resolveTenantByHost` safely falls back to apex — i.e. this is
// FORWARD-COMPATIBLE and inert (not wrong) until the header exists.
function viewerHost(headers?: Record<string, string>): string | undefined {
  return headers?.['x-pds-viewer-host'] || headers?.host || headers?.Host
}

// ---------------------------------------------------------------------------
// Helper: resolve a repo/did param for read paths.
// Returns the tenant or throws an xrpcError-tagged error.
// ---------------------------------------------------------------------------

async function resolveReadTenant(input: { did?: string; handle?: string }): Promise<import('./tenant').Tenant> {
  const store = makeTenantStore()
  const tenant = await resolveTenant(input, store)
  if (!tenant) {
    const e: any = new Error(`Repo not found`)
    e.xrpcError = 'RepoNotFound'
    throw e
  }
  return tenant
}

// ---------------------------------------------------------------------------
// Write context: resolve the verified DID to its tenant, then build the
// per-tenant storage + signing keypair for a repo write.
//
// APEX NON-REGRESSION: when auth === APEX_DID, resolveTenant() short-circuits
// to apexTenant() (no DDB read) and we sign with the EXACT same SSM param the
// legacy makeSigningKey() used today — process.env[ENV.SIGNING_KEY_PARAM] —
// so the apex write path is byte-identical regardless of how SIGNING_KEY_PARAM
// vs SIGNING_KEY_SSM happen to be configured. Storage is keyed APEX_DID, which
// keyFor() maps to the legacy literal ACCOUNT/BLOCK keys. Sub-users resolve
// through the TenantStore and sign with their own per-tenant key ref; an
// unknown/inactive DID yields the existing RepoNotFound RouteResult (400),
// never a 500 and never an apex write.
// ---------------------------------------------------------------------------

async function writeCtx(
  auth: string,
): Promise<{ storage: DynamoRepoStorage; keypair: Secp256k1Keypair; did: string } | RouteResult> {
  const tenant = await resolveTenant({ did: auth }, makeTenantStore())
  if (!tenant) {
    return jsonErr(400, 'RepoNotFound', 'Repo not found')
  }
  const keypair =
    tenant.did === APEX_DID
      ? // Byte-identical to legacy makeSigningKey(): same param string, today.
        await getSigningKey(process.env[ENV.SIGNING_KEY_PARAM]!)
      : await getSigningKey(tenant.signingKeyRef)
  // tenant.did is the identity stamped into the returned uri AND the firehose
  // #commit body.repo. For apex this is APEX_DID === the legacy module `DID`
  // value, so the apex write path is byte-identical.
  return { storage: makeStorage(tenant.did), keypair, did: tenant.did }
}

// app.bsky.* reads that are identical for every viewer and are used by the
// logged-out SPA (profile/post pages, search, home feed). Served unauthenticated
// as the apex identity. Anything not listed needs a signed-in caller.
const PUBLIC_APPVIEW_READS: ReadonlySet<string> = new Set([
  'app.bsky.actor.getProfile',
  'app.bsky.actor.getProfiles',
  'app.bsky.feed.getAuthorFeed',
  'app.bsky.feed.getPostThread',
  'app.bsky.feed.getPosts',
  'app.bsky.graph.getFollows',
  'app.bsky.graph.getFollowers',
  // SearchScreen calls these without a token.
  'app.bsky.actor.searchActors',
  'app.bsky.feed.searchPosts',
])

/**
 * A write whose body names a `repo` other than the caller's own must not
 * silently land in the token's repo (writeCtx ignores `repo`). `repo` may be a
 * DID or a handle, so a handle is resolved before comparing. Omitted `repo`
 * keeps the historical "write to the token's repo" behavior.
 */
async function repoMismatch(body: any, ownDid: string): Promise<RouteResult | null> {
  const repo = body?.repo
  if (repo === undefined || repo === null || repo === '') return null
  if (typeof repo !== 'string') return jsonErr(400, 'InvalidRequest', "Invalid 'repo'")
  if (repo === ownDid) return null
  if (!repo.startsWith('did:')) {
    const t = await resolveTenant({ handle: repo.toLowerCase() }, makeTenantStore())
    if (t && t.did === ownDid) return null
  }
  // 400, not 403: CloudFront rewrites 403s to the SPA shell with a 200.
  return jsonErr(400, 'InvalidRequest', 'repo does not match the authenticated account')
}

function isRouteResult(x: unknown): x is RouteResult {
  return typeof x === 'object' && x !== null && 'status' in x && 'body' in x
}

// ---------------------------------------------------------------------------
// Pure router — no APIGW types; fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Route an XRPC call.
 *
 * @param method   HTTP verb (GET, POST, …)
 * @param nsid     XRPC method NSID (e.g. "com.atproto.server.describeServer")
 * @param query    Parsed query-string parameters
 * @param body     Parsed JSON body (or null for GET), or raw Uint8Array for binary uploads
 * @param auth     Already-verified DID string if bearer was valid, else null
 * @param headers  Lowercase request headers (optional; used for content-type on blob upload)
 * @param adminEmail  Already-verified magic-link caller email (or null) — used
 *                    ONLY by the additive social.serverless.analytics case;
 *                    every pre-existing case ignores it (byte-identical).
 */
export async function route(
  method: string,
  nsid: string,
  query: Record<string, string>,
  body: any,
  auth: string | null,
  headers?: Record<string, string>,
  adminEmail: string | null = null,
): Promise<RouteResult> {
  try {
    switch (nsid) {
      // ── com.atproto.server.describeServer ─────────────────────────────────
      // `did` is ALWAYS the apex PDS service DID (did:web:serverless.social) —
      // that's this PDS's own identity, not the caller's; every tenant's DID
      // document already points its `pds` service endpoint at this same
      // host, so returning the PDS's own did here is spec-correct regardless
      // of which host asked. `availableUserDomains` IS host-aware (via the
      // same resolveTenantByHost() the .well-known/atproto-did route uses),
      // since it genuinely differs per host with zero blast radius: apex
      // requests fall through to the exact byte-identical apexTenant()
      // literal, unchanged from before this case existed.
      case 'com.atproto.server.describeServer': {
        const tenant = await resolveTenantByHost(viewerHost(headers), makeTenantStore())
        return jsonOk({ ...describeServerFor(tenant), did: APEX_DID })
      }

      // ── com.atproto.identity.resolveHandle ────────────────────────────────
      case 'com.atproto.identity.resolveHandle': {
        const handle = query.handle
        if (!handle) {
          return jsonErr(400, 'InvalidRequest', 'Missing required parameter: handle')
        }
        const tenant = await resolveTenant({ handle }, makeTenantStore())
        if (!tenant) {
          const e: any = new Error(`Unable to resolve handle: ${handle}`)
          e.xrpcError = 'InvalidRequest'
          throw e
        }
        return jsonOk({ did: tenant.did })
      }

      // ── com.atproto.server.createSession ──────────────────────────────────
      // Single-tenant auth: identifier must be HANDLE or DID AND the password
      // must match the app password in SSM (env PDS_APP_PASSWORD_PARAM).
      // Fails closed when the parameter is unset or unreadable.
      case 'com.atproto.server.createSession': {
        const identifier: string = body?.identifier ?? ''
        const password: string = typeof body?.password === 'string' ? body.password : ''
        if (identifier !== HANDLE && identifier !== DID) {
          return jsonErr(401, 'AuthRequired', 'Invalid identifier')
        }
        if (!(await verifyAppPassword(password, process.env.PDS_APP_PASSWORD_PARAM))) {
          return jsonErr(401, 'AuthenticationRequired', 'Invalid password')
        }
        const secret = await getJwtSecret()
        const session = await makeSession(secret)
        return jsonOk(session)
      }

      // ── com.atproto.server.getSession ─────────────────────────────────────
      case 'com.atproto.server.getSession': {
        if (!auth) return authRequired()
        // The token's own identity: a tenant (martzmakes.com) session used to
        // get the apex identity back here, which misled clients and scripts.
        const t = await resolveTenant({ did: auth }, makeTenantStore())
        if (!t) return jsonErr(400, 'RepoNotFound', 'Repo not found')
        return jsonOk({ did: t.did, handle: t.handle })
      }

      // ── com.atproto.server.getServiceAuth ─────────────────────────────────
      // Mint a short-lived ES256K JWT signed with the caller's repo signing key.
      // bsky.app uses this to authenticate to the AppView (and other services)
      // on behalf of the user — the AppView resolves `iss` via PLC and verifies
      // the signature against the user's published verification key.
      //
      // Spec: com.atproto.server.getServiceAuth
      //   GET ?aud=<DID> &exp=<unix-seconds, optional> &lxm=<NSID, optional>
      //   → { token: string }
      //
      // Constraints (atproto OAuth spec + defense-in-depth):
      //   - aud is required and must look like a DID (`did:…`)
      //   - exp is capped at iat+1h (3600s) to limit blast radius if leaked
      //   - lxm is optional; when present, narrows the JWT to one lexicon method
      case 'com.atproto.server.getServiceAuth': {
        if (!auth) return authRequired()
        const aud = query.aud
        if (!aud || typeof aud !== 'string' || !aud.startsWith('did:')) {
          return jsonErr(400, 'InvalidRequest', "Missing or invalid 'aud' parameter (must be a DID)")
        }
        const lxm = typeof query.lxm === 'string' ? query.lxm : ''
        const nowSec = Math.floor(Date.now() / 1_000)
        const MAX_TTL_SEC = 3600 // 1 hour, per atproto spec
        let expSec = 60
        if (query.exp !== undefined && query.exp !== '') {
          const requestedExp = parseInt(query.exp, 10)
          if (!Number.isFinite(requestedExp)) {
            return jsonErr(400, 'InvalidRequest', "Invalid 'exp' parameter")
          }
          const ttl = requestedExp - nowSec
          if (ttl <= 0) {
            return jsonErr(400, 'BadExpiration', "'exp' must be in the future")
          }
          expSec = Math.min(ttl, MAX_TTL_SEC)
        }
        const ctx = await writeCtx(auth)
        if (isRouteResult(ctx)) return ctx
        const token = await serviceAuthJwt(ctx.keypair, lxm, aud, ctx.did, expSec)
        return jsonOk({ token })
      }

      // ── com.atproto.server.refreshSession ────────────────────────────────
      // The refresh JWT is read from the request body (refreshJwt field).
      // The Authorization header is not used here.
      case 'com.atproto.server.refreshSession': {
        const refreshJwt: string | undefined = body?.refreshJwt ?? undefined
        if (!refreshJwt) return authRequired()
        try {
          const secret = await getJwtSecret()
          await verifyRefresh(refreshJwt, secret)
          const session = await makeSession(secret)
          return jsonOk(session)
        } catch {
          return jsonErr(401, 'AuthRequired', 'Invalid or expired refresh token')
        }
      }

      // ── com.atproto.repo.createRecord ─────────────────────────────────────
      case 'com.atproto.repo.createRecord': {
        if (!auth) return authRequired()
        const ctx = await writeCtx(auth)
        if (isRouteResult(ctx)) return ctx
        const mismatch = await repoMismatch(body, ctx.did)
        if (mismatch) return mismatch
        const result = await createRecord(ctx.storage, ctx.keypair, ctx.did, {
          collection: body?.collection,
          rkey: body?.rkey,
          record: body?.record,
        })
        return jsonOk(result)
      }

      // ── com.atproto.repo.putRecord ────────────────────────────────────────
      case 'com.atproto.repo.putRecord': {
        if (!auth) return authRequired()
        const ctx = await writeCtx(auth)
        if (isRouteResult(ctx)) return ctx
        const mismatch = await repoMismatch(body, ctx.did)
        if (mismatch) return mismatch
        const result = await putRecord(ctx.storage, ctx.keypair, ctx.did, {
          collection: body?.collection,
          rkey: body?.rkey,
          record: body?.record,
        })
        return jsonOk(result)
      }

      // ── com.atproto.repo.deleteRecord ─────────────────────────────────────
      case 'com.atproto.repo.deleteRecord': {
        if (!auth) return authRequired()
        const ctx = await writeCtx(auth)
        if (isRouteResult(ctx)) return ctx
        const mismatch = await repoMismatch(body, ctx.did)
        if (mismatch) return mismatch
        const result = await deleteRecord(ctx.storage, ctx.keypair, ctx.did, {
          collection: body?.collection,
          rkey: body?.rkey,
        })
        return jsonOk(result)
      }

      // ── com.atproto.repo.getRecord ────────────────────────────────────────
      case 'com.atproto.repo.getRecord': {
        const repoDid = query.repo ?? body?.repo ?? APEX_DID
        const tenant = await resolveReadTenant({ did: repoDid })
        const storage = makeStorage(tenant.did)
        const result = await getRecord(storage, tenant.did, {
          collection: query.collection ?? body?.collection,
          rkey: query.rkey ?? body?.rkey,
        })
        return jsonOk(result)
      }

      // ── com.atproto.repo.listRecords ──────────────────────────────────────
      case 'com.atproto.repo.listRecords': {
        const repoDid = query.repo ?? body?.repo ?? APEX_DID
        const tenant = await resolveReadTenant({ did: repoDid })
        const storage = makeStorage(tenant.did)
        const limit = query.limit ? parseInt(query.limit, 10) : undefined
        const result = await listRecords(storage, tenant.did, {
          collection: query.collection ?? body?.collection,
          limit: isNaN(limit!) ? undefined : limit,
          cursor: query.cursor,
          reverse: query.reverse === 'true',
        })
        return jsonOk(result)
      }

      // ── com.atproto.repo.describeRepo ─────────────────────────────────────
      case 'com.atproto.repo.describeRepo': {
        const repoDid = query.repo ?? body?.repo ?? APEX_DID
        const tenant = await resolveReadTenant({ did: repoDid })
        const storage = makeStorage(tenant.did)
        const result = await describeRepo(storage, tenant.did, tenant.handle)
        return jsonOk(result)
      }

      // ── com.atproto.sync.getRepo ──────────────────────────────────────────
      // Returns the full CAR as binary. APIGW requires base64 for binary
      // payloads when isBase64Encoded=true is set. The handler() entry point
      // reads this flag and sets it on the APIGW response accordingly.
      case 'com.atproto.sync.getRepo': {
        const repoDid = query.did ?? APEX_DID
        const tenant = await resolveReadTenant({ did: repoDid })
        const storage = makeStorage(tenant.did)
        const car = await getRepoCar(storage)
        // Base64-encode for APIGW binary passthrough
        const base64 = Buffer.from(car).toString('base64')
        return {
          status: 200,
          body: base64,
          contentType: 'application/vnd.ipld.car',
          isBase64Encoded: true,
        }
      }

      // ── com.atproto.sync.getLatestCommit ──────────────────────────────────
      case 'com.atproto.sync.getLatestCommit': {
        const repoDid = query.did ?? APEX_DID
        const tenant = await resolveReadTenant({ did: repoDid })
        const storage = makeStorage(tenant.did)
        const result = await getLatestCommit(storage)
        return jsonOk(result)
      }

      // ── com.atproto.sync.listRepos ────────────────────────────────────────
      case 'com.atproto.sync.listRepos': {
        return jsonOk(await listRepos(makeTenantStore()))
      }

      // ── com.atproto.repo.uploadBlob ───────────────────────────────────────
      // POST, auth required. Body is raw binary bytes (already decoded by
      // handler() below). mimeType comes from the content-type header.
      case 'com.atproto.repo.uploadBlob': {
        if (!auth) return authRequired()
        const bytes: Uint8Array =
          body instanceof Uint8Array ? body : new Uint8Array(0)
        if (bytes.length === 0) {
          return jsonErr(400, 'InvalidRequest', 'empty blob')
        }
        const mimeType =
          (headers?.['content-type'] ?? 'application/octet-stream')
            .split(';')[0]
            .trim()
        const s3 = makeS3()
        const bucket = process.env.BLOB_BUCKET!
        const { blob } = await putBlob(s3, bucket, bytes, mimeType)
        return jsonOk({ blob })
      }

      // ── com.atproto.sync.getBlob ──────────────────────────────────────────
      // GET, no auth. ?did=<did>&cid=<cidStr> → binary response.
      case 'com.atproto.sync.getBlob': {
        const _did = query.did // single-tenant: did is accepted per spec but not validated (only one DID). TODO: validate did===DID when multi-tenant.
        const cidStr = query.cid
        if (!cidStr) {
          return jsonErr(400, 'InvalidRequest', 'Missing required parameter: cid')
        }
        const s3 = makeS3()
        const bucket = process.env.BLOB_BUCKET!
        const result = await getBlob(s3, bucket, cidStr)
        if (!result) {
          return jsonErr(404, 'BlobNotFound', `Blob not found: ${cidStr}`)
        }
        const base64 = Buffer.from(result.bytes).toString('base64')
        return {
          status: 200,
          body: base64,
          contentType: result.mimeType,
          isBase64Encoded: true,
        }
      }

      // ── com.atproto.sync.listBlobs ────────────────────────────────────────
      // GET, no auth. ?did=<did>[&limit=<n>][&cursor=<lastCid>][&since=<rev>]
      // → { cids: string[], cursor?: string }.
      //
      // Repo portability: enumerate the blob CIDs a repo's records reference
      // so a migrated account can be backed up / relayed / re-migrated, and so
      // the migration live-proof can use serverless.social as its own source.
      // (Pages through listRecords with its real cursor — see the loop below.)
      //
      // Read path is structurally identical to getRepo/listRecords: resolve
      // the DID's tenant (apex short-circuits in resolveTenant exactly like
      // getRepo), build per-tenant storage, then enumerate records via the
      // existing repo-read seam (describeRepo → listRecords per collection) —
      // NO new raw storage scan. Pure-additive read; apex is byte-identical.
      //
      // `since` (rev): accepted per spec but intentionally ignored — a correct
      // minimal impl MAY skip it; our migrateBlobs/live-proof don't use it.
      case 'com.atproto.sync.listBlobs': {
        const repoDid = query.did
        if (!repoDid) {
          return jsonErr(400, 'InvalidRequest', 'Missing required parameter: did')
        }
        const tenant = await resolveReadTenant({ did: repoDid })
        const storage = makeStorage(tenant.did)

        // Enumerate every record value across every collection using the SAME
        // existing read path getRepo/listRecords use (no raw storage scan).
        const { collections } = await describeRepo(
          storage,
          tenant.did,
          tenant.handle,
        )
        const recordValues: unknown[] = []
        for (const collection of collections) {
          let cursor: string | undefined = undefined
          // listRecords clamps limit to 100 and returns a real cursor, so
          // this loop pages through the whole collection.
          do {
            const page: import('./repo-read').ListRecordsOutput =
              await listRecords(storage, tenant.did, {
                collection,
                limit: 100,
                cursor,
              })
            for (const rec of page.records) recordValues.push(rec.value)
            cursor = page.cursor
          } while (cursor)
        }

        // Deterministic stable-sorted union of blob CIDs (stable order makes
        // the cursor + the live-proof fingerprint reproducible).
        const allCids = collectRepoBlobCids(recordValues)

        // limit: default 500, clamp 1..1000.
        const parsedLimit = query.limit ? parseInt(query.limit, 10) : NaN
        const limit = isNaN(parsedLimit)
          ? 500
          : Math.min(1000, Math.max(1, parsedLimit))

        // Opaque cursor = the last-returned cid; slice the deterministic
        // sorted list strictly after it.
        let startIdx = 0
        if (query.cursor) {
          const found = allCids.indexOf(query.cursor)
          startIdx = found === -1 ? allCids.length : found + 1
        }
        const pageCids = allCids.slice(startIdx, startIdx + limit)
        const nextCursor =
          startIdx + limit < allCids.length
            ? pageCids[pageCids.length - 1]
            : undefined

        return jsonOk({ cids: pageCids, cursor: nextCursor })
      }

      // ── social.serverless.analytics ──────────────────────────────────────
      // GET, ADMIN-ONLY (Spec #8 / Phase E — Task 4). PURE-ADDITIVE: a brand
      // new NSID `case` mirroring the com.atproto.sync.listBlobs precedent
      // EXACTLY (a new GET case that builds a doc client + reads its env table
      // + returns {status,json} via the response helpers) — it touches NO
      // existing case/route and is unreachable for any pre-Task-4 NSID.
      //
      // Auth is the EXACT existing magic-link/ADMIN_EMAIL gate, NOT a new or
      // weaker surface: handler() below verifies the caller's Bearer with the
      // SAME auth/lib/jwt.ts:verifyJwt the auth API uses and passes the
      // resulting email here as `adminEmail` (null on no/invalid token);
      // analyticsRead() compares it to `process.env.ADMIN_EMAIL ??
      // configured in the stack, matching auth/me.ts /
      // auth/pds-session.ts — and returns 401 with ZERO data + ZERO DDB call
      // for anything that is not exactly the admin.
      //
      // ZERO PII: analyticsRead only ever surfaces aggregate counts, eTLD+1
      // referrer hosts, the public post URI, and the slug.
      case 'social.serverless.analytics': {
        const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
        const r = await analyticsRead({
          adminEmail,
          query,
          doc,
          table: process.env.POST_ANALYTICS_TABLE!,
          // Apex host + custom tenant hosts: without ?host= the reader sums
          // every per-host partition, not just the frozen legacy rows.
          hosts: [
            process.env.PDS_HANDLE ?? 'serverless.social',
            ...parseCustomHosts(process.env.AP_CUSTOM_HOSTS),
          ],
        })
        return {
          status: r.status,
          body: JSON.stringify(r.json),
          contentType: 'application/json',
        }
      }

      // ── app.bsky.* — proxy to AppView ────────────────────────────────────
      default: {
        if (nsid.startsWith('app.bsky.')) {
          // Viewer-scoped reads (getTimeline, notifications, preferences, …)
          // must run AS the signed-in user: the service JWT's iss/key are the
          // caller's tenant. Without auth only the PUBLIC_APPVIEW_READS
          // allowlist is served, as the apex identity; everything else is 401
          // (it would otherwise return the apex account's personal view).
          if (!auth && !PUBLIC_APPVIEW_READS.has(nsid)) return authRequired()
          try {
            let kp: Awaited<ReturnType<typeof makeSigningKey>>
            let iss = APEX_DID
            if (auth) {
              const ctx = await writeCtx(auth)
              if (isRouteResult(ctx)) {
                // Unknown/inactive tenant: never silently fall back to apex
                // for a viewer-scoped method.
                if (!PUBLIC_APPVIEW_READS.has(nsid)) return ctx
                kp = await makeSigningKey()
              } else {
                kp = ctx.keypair
                iss = ctx.did
              }
            } else {
              kp = await makeSigningKey()
            }
            const result = await proxyAppView(nsid, query, kp, { iss })
            return {
              status: result.status,
              body: result.body,
              contentType: result.contentType,
            }
          } catch {
            return jsonErr(502, 'UpstreamFailure', 'AppView request failed')
          }
        }
        return jsonErr(501, 'MethodNotImplemented', nsid)
      }
    }
  } catch (err: any) {
    // Errors with an xrpcError property are protocol-level errors
    if (err?.xrpcError) {
      return jsonErr(
        xrpcErrorStatus(err.xrpcError),
        err.xrpcError,
        err.message,
      )
    }
    // Generic errors — log server-side for diagnosability (CloudWatch only;
    // never leaked to the client) then return an opaque 500.
    console.error('[xrpc] unhandled error', nsid, err?.name, err?.message, err?.stack)
    return jsonErr(500, 'InternalError', 'An unexpected error occurred')
  }
}

// ---------------------------------------------------------------------------
// APIGW HTTP API v2 entrypoint
// ---------------------------------------------------------------------------

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-expose-headers': 'www-authenticate',
  }
}

export const handler = async (event: APIGatewayProxyEventV2) => {
  const method = event.requestContext.http.method
  const rawPath = event.rawPath || ''

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' }
  }

  // ── Well-known routes ───────────────────────────────────────────────────
  // /.well-known/did.json — apex only (did:web; plc tenants have no did.json here)
  if (method === 'GET' && rawPath === '/.well-known/did.json') {
    const kp = await getSigningKey(process.env[ENV.SIGNING_KEY_PARAM]!)
    const doc = didDocument(await kp.did())
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', ...corsHeaders() },
      body: JSON.stringify(doc),
    }
  }

  // /.well-known/atproto-did — serve the DID for whatever host is being
  // requested, via resolveTenantByHost() (same TenantStore lookup
  // resolveHandle already does for an explicit ?handle= param). The apex
  // domain (or any unrecognized/missing host) short-circuits to APEX_DID —
  // byte-identical to the previous unconditional-DID response.
  if (method === 'GET' && rawPath === '/.well-known/atproto-did') {
    const tenant = await resolveTenantByHost(viewerHost(event.headers as Record<string, string> | undefined), makeTenantStore())
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/plain', ...corsHeaders() },
      body: tenant.did,
    }
  }

  // ── XRPC routing ────────────────────────────────────────────────────────
  // Strip /xrpc/ prefix to get the NSID
  const xrpcPrefix = '/xrpc/'
  if (!rawPath.startsWith(xrpcPrefix)) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({ error: 'NotFound', message: rawPath }),
    }
  }
  const nsid = rawPath.slice(xrpcPrefix.length).split('?')[0]

  // Parse query string
  const query: Record<string, string> = {}
  if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v !== undefined) query[k] = v
    }
  }

  // Parse body (handle base64 encoding from APIGW)
  // For uploadBlob we pass raw bytes; for all other routes we parse JSON.
  let body: any = null
  if (event.body) {
    if (nsid === 'com.atproto.repo.uploadBlob') {
      // Binary body — decode base64 (APIGW always base64-encodes binary)
      body = event.isBase64Encoded
        ? new Uint8Array(Buffer.from(event.body, 'base64'))
        : new Uint8Array(Buffer.from(event.body, 'utf8'))
    } else {
      try {
        const rawBody = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body
        body = JSON.parse(rawBody)
      } catch {
        // non-JSON body — leave as null
      }
    }
  }

  // Extract and verify the request auth (Bearer or DPoP) via verifyXrpcAuth.
  // Apex first-party Bearer tokens have no `cnf` claim, so they pass exactly
  // as before (no DPoP proof required) — the apex/plain-Bearer path is
  // preserved. DPoP-bound (sub-user) tokens require a matching DPoP proof.
  const authHeader =
    event.headers?.authorization || event.headers?.Authorization
  const dpopHeader = event.headers?.dpop || event.headers?.DPoP
  const fullUrl = `https://${HANDLE}${rawPath}`
  let auth: string | null = null
  try {
    const identity = await verifyXrpcAuth(
      authHeader,
      dpopHeader,
      method,
      fullUrl,
      makeTenantStore(),
      await getJwtSecret(),
      makeXrpcSeenJtiPort(),
    )
    auth = identity?.did ?? null
  } catch {
    // Invalid token — treat as unauthenticated (not a 401 here; route() will
    // return 401 if the endpoint requires auth).
    auth = null
  }

  // Lowercase all headers for consistent lookup in route()
  const lowercaseHeaders: Record<string, string> = {}
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      if (v !== undefined) lowercaseHeaders[k.toLowerCase()] = v
    }
  }

  // Resolve the caller's MAGIC-LINK email for the additive admin-only
  // social.serverless.analytics case ONLY — using the EXACT same
  // auth/lib/jwt.ts:verifyJwt + Bearer-parse idiom auth/me.ts uses (sub ==
  // email, issuer DOMAIN, audience PROJECT_SLUG_app; the xrpc Lambda already
  // has JWT_SECRET_NAME/DOMAIN/PROJECT_SLUG in its env via lambdaDefaults).
  // No/invalid/non-magic-link token → null → analyticsRead returns 401 with
  // zero data. This does NOT touch the existing verifyXrpcAuth `auth` (DID)
  // path above and is irrelevant to every pre-existing route.
  let adminEmail: string | null = null
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader ?? '')
  if (bearerMatch) {
    try {
      const { email } = await verifyJwt(bearerMatch[1])
      adminEmail = email
    } catch {
      adminEmail = null
    }
  }

  // Dispatch to pure router
  const result = await route(
    method,
    nsid,
    query,
    body,
    auth,
    lowercaseHeaders,
    adminEmail,
  )

  // Build APIGW response
  const headers: Record<string, string> = {
    'content-type': result.contentType ?? 'application/json',
    ...corsHeaders(),
  }

  return {
    statusCode: result.status,
    headers,
    body: result.body,
    isBase64Encoded: result.isBase64Encoded ?? false,
  }
}
