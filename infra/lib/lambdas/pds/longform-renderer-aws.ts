// CloudFront KeyValueStore data-plane ops require region-agnostic SigV4a signing.
// @aws-sdk/client-cloudfront-keyvaluestore -> @aws-sdk/signature-v4-multi-region
// resolves the SigV4a signer ONLY from @smithy/signature-v4's signatureV4aContainer,
// which @aws-sdk/signature-v4a populates as an import side-effect
// (@smithy/signature-v4a sets `signatureV4aContainer.SignatureV4a = SignatureV4a`).
// The SDK's internal optional require is NOT statically reachable by esbuild's
// full-bundle (externalModules:[]), so without this explicit side-effecting import
// every kvs.send() throws "Neither CRT nor JS SigV4a implementation is available".
// @aws-sdk/signature-v4a declares "sideEffects": true, so esbuild will not
// tree-shake this import. Referencing the binding is belt-and-suspenders.
import * as __sigv4a from '@aws-sdk/signature-v4a'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { CloudFrontKeyValueStoreClient, PutKeyCommand, DeleteKeyCommand, DescribeKeyValueStoreCommand } from '@aws-sdk/client-cloudfront-keyvaluestore'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import type { Ports, RenderEvent, TenantScope } from './longform-renderer'
import type { RenderCtx } from './longform-render'
import { makeSession, makeSessionFor } from './session'
import { ENV } from './lexicons'
import * as lex from './lexicons'
import { resolveTenant, apexTenant, type TenantStore } from './tenant'
import { APEX_DID } from './tenant-keys'
import { renderTargetForTenant, type RenderTarget } from './longform-tenant'
import { prepareCoverPreview } from './cover-preview'

const COLL = ((lex as any).LONGFORM_COLLECTION as string) || 'social.serverless.longform'

/** Apex deploy-env config — the SINGLE source for apex render identity.
 *  Threaded into renderTargetForTenant so apex → byte-identical to the
 *  historical ctxFromEnv() + empty S3 prefix. */
function apexCfg() {
  return {
    apexOrigin: process.env.PUBLIC_ORIGIN!,
    apexSiteName: process.env.SITE_NAME || 'Serverless Social',
    apexHandle: process.env.PDS_HANDLE!,
  }
}

export function ctxFromEnv(): RenderCtx {
  const a = apexCfg()
  return { origin: a.apexOrigin, siteName: a.apexSiteName, author: a.apexHandle }
}

/** Tenant store for the renderer Lambda — mirrors handler.ts makeTenantStore()
 *  (same TENANTS_TABLE, same byDid GetCommand). byHandle/listActive are unused
 *  by the renderer (DID-keyed only) but kept for the TenantStore contract. */
export function makeRendererTenantStore(): TenantStore {
  // removeUndefinedValues: the index item embeds optional fields (e.g. an
  // un-syndicated post's `syndication` state) that can be undefined; without
  // this the PutCommand throws "Pass options.removeUndefinedValues=true ..."
  // and the renderer crash-loops on the DDB stream (HTML renders, but putIndex/
  // feeds/syndication never complete).
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })
  const table = process.env[ENV.TENANTS_TABLE]!
  return {
    async byDid(did: string) {
      const res = await ddb.send(new GetCommand({ TableName: table, Key: { did } }))
      return res.Item ?? null
    },
    async byHandle(handle: string) {
      const res = await ddb.send(new QueryCommand({
        TableName: table, IndexName: 'byHandle',
        KeyConditionExpression: 'handle = :h',
        ExpressionAttributeValues: { ':h': handle }, Limit: 1,
      }))
      return res.Items?.[0] ?? null
    },
    async listActive() { return [] },
  }
}

/** Resolve an event's repo DID → a RenderTarget.
 *  Apex (did === APEX_DID) short-circuits in resolveTenant with NO store read,
 *  yielding the exact apex ctx values + s3Prefix:'' (byte-identical). A
 *  non-active / unknown sub-user DID falls back to apex (renders nothing new
 *  vs. today; never throws differently for apex). */
export async function targetForRepo(did: string, store: TenantStore): Promise<RenderTarget> {
  const apex = apexCfg()
  const t = await resolveTenant({ did }, store)
  const isApex = !t || t.did === APEX_DID
  const descriptor = isApex
    ? { did: APEX_DID, handle: apex.apexHandle, isApex: true }
    : { did: t!.did, handle: t!.handle, isApex: false }
  return renderTargetForTenant(descriptor, apex)
}

// The renderer ESM (infra-stack.ts) OR's an apex `RECORD#<COLL>/` prefix with
// a broad `did:` prefix (GAP#1 — sub-tenant longform pks start with `did:`,
// not `RECORD#`, and the DID varies so cannot be prefix-matched precisely).
// Consequence: this Lambda is invoked on EVERY tenant record write (likes,
// posts, profiles, …), not just longform. eventsFromStream is the cheap
// in-code gate: it yields an event ONLY for an apex `RECORD#<COLL>/<rkey>`
// pk or a sub-tenant `<did>#RECORD#<COLL>/<rkey>` pk, and returns NOTHING
// (no IO, no event) for anything else — non-longform sub records, blocks,
// account rows, malformed pks. Negligible cost: renderer scales to zero and
// the drop path does zero work.
export function eventsFromStream(event: { Records: any[] }): RenderEvent[] {
  const evs: RenderEvent[] = []
  const apexPrefix = `RECORD#${COLL}/`
  const subInfix = `#RECORD#${COLL}/`
  for (const r of event.Records || []) {
    const pk: string | undefined = r.dynamodb?.Keys?.pk?.S
    if (!pk) continue
    let did: string
    let rkey: string
    if (pk.startsWith(apexPrefix)) {
      // Apex pk (keyFor(apex,'record')): byte-identical to the historical
      // single-tenant path → tag with APEX_DID so targetForRepo short-circuits
      // (no DDB read, s3Prefix:'').
      did = APEX_DID
      rkey = pk.slice(apexPrefix.length)
    } else {
      // Over-delivery early-skip: only a sub-tenant LONGFORM record pk
      // (`<did>#RECORD#social.serverless.longform/<rkey>`) contains the
      // `#RECORD#<COLL>/` infix at a positive index. Every other delivered
      // pk (sub `app.bsky.feed.*` records, `<did>#BLOCK#…`, `<did>#ACCOUNT`,
      // bare apex non-longform, etc.) misses it → cheap drop, no event.
      const i = pk.indexOf(subInfix)
      if (i <= 0) continue
      did = pk.slice(0, i)
      rkey = pk.slice(i + subInfix.length)
    }
    if (r.eventName === 'REMOVE') evs.push({ rkey, op: 'delete', did })
    else evs.push({ rkey, op: 'upsert', cid: r.dynamodb?.NewImage?.cid?.S, did })
  }
  return evs
}

// --- auth: mint+cache an accessJwt the SAME way the existing PDS write path does ---
// Mirrors handler.ts: getJwtSecret() loads from SSM SecureString at ENV.JWT_SECRET_PARAM,
// then calls makeSession(secret) from session.ts and caches the .accessJwt.
const _ssm = new SSMClient({})
let _cachedJwtSecret: Uint8Array | null = null

async function getJwtSecret(): Promise<Uint8Array> {
  if (_cachedJwtSecret) return _cachedJwtSecret
  const res = await _ssm.send(
    new GetParameterCommand({
      Name: process.env[ENV.JWT_SECRET_PARAM]!,
      WithDecryption: true,
    }),
  )
  const value = res.Parameter?.Value
  if (!value) throw new Error('JWT secret SSM param is empty')
  _cachedJwtSecret = new TextEncoder().encode(value)
  return _cachedJwtSecret
}

/** Per-DID access-token cache. Syndication must be written AS the author:
 *  the xrpc write path resolves the repo from the token's `sub`, so a tenant
 *  post needs a token minted for the tenant DID (apex token = apex repo).
 *  Apex uses the historical makeSession() (byte-identical token shape). */
const _jwtByDid = new Map<string, string>()

function jwtStillFresh(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' && Date.now() / 1000 < payload.exp - 300
  } catch { return false /* re-mint on any decode issue */ }
}

async function accessJwt(scope?: TenantScope): Promise<string> {
  const did = !scope || scope.isApex ? APEX_DID : scope.did
  const hit = _jwtByDid.get(did)
  if (hit && jwtStillFresh(hit)) return hit
  const secret = await getJwtSecret()
  const session = did === APEX_DID
    ? await makeSession(secret)
    : await makeSessionFor({ ...apexTenant(), did, handle: '', method: 'plc' }, secret)
  _jwtByDid.set(did, session.accessJwt)
  return session.accessJwt
}

export function makeAwsPorts(): Ports {
  // Force-retain the SigV4a registration side-effect import (see top of file).
  // Touching the namespace guarantees esbuild keeps the module + its
  // signatureV4aContainer.SignatureV4a assignment in the bundle.
  if (!__sigv4a) throw new Error('SigV4a signer registration module missing from bundle')
  const s3 = new S3Client({})
  // removeUndefinedValues: the index item embeds optional fields (e.g. an
  // un-syndicated post's `syndication` state) that can be undefined; without
  // this the PutCommand throws "Pass options.removeUndefinedValues=true ..."
  // and the renderer crash-loops on the DDB stream (HTML renders, but putIndex/
  // feeds/syndication never complete).
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })
  const kvs = new CloudFrontKeyValueStoreClient({})
  const bucket = process.env.SITE_BUCKET!
  const table = process.env.LONGFORM_INDEX_TABLE!
  const kvsArn = process.env.KVS_ARN!
  const origin = process.env.PUBLIC_ORIGIN!
  const did = process.env.PDS_DID!

  // KVS uses optimistic concurrency (IfMatch=ETag). Fetching a fresh ETag per
  // write is only race-free if there is NO concurrent writer to this KVS.
  // The renderer Lambda MUST therefore be deployed with reservedConcurrentExecutions=1
  // (enforced in the stack wiring, Task 9). Do not raise that concurrency without
  // switching to the UpdateKeys batch API.
  const etag = async () => (await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }))).ETag!

  // --- GAP#2: tenant-vs-apex key derivation -------------------------------
  // apex (scope.isApex OR scope omitted) → EXACT historical literals:
  //   index pk      = 'IDX'              (flat single partition, unchanged)
  //   KVS key       = bare `slug`        (unchanged redirect/410 namespace)
  //   getRecord/PDS = process.env.PDS_DID (apex repo, unchanged)
  // sub-tenant → namespaced so identical rkey/slug across tenants never
  // collide with apex or each other:
  //   index pk      = `IDX#<did>`        (per-tenant partition)
  //   KVS key       = `<s3Prefix><slug>` (consistent with the S3 prefix)
  //   getRecord/PDS = the event's tenant repo DID
  // Apex literals are returned UNCHANGED — apex index/redirect/repo state
  // (and the apex byte-lock) are untouched.
  const isApexScope = (sc?: TenantScope) => !sc || sc.isApex
  const idxPk = (sc?: TenantScope) => (isApexScope(sc) ? 'IDX' : `IDX#${sc!.did}`)
  const kvsKey = (slug: string, sc?: TenantScope) => (isApexScope(sc) ? slug : `${sc!.s3Prefix}${slug}`)
  const repoDid = (sc?: TenantScope) => (isApexScope(sc) ? did : sc!.did)

  return {
    prepareCover(cover, siteOrigin, scope) {
      return prepareCoverPreview({ s3, bucket, cover, siteOrigin, pdsOrigin: origin, did: repoDid(scope) })
    },
    async getProfile(scope) {
      const repo = repoDid(scope)
      const u = `${origin}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}&collection=app.bsky.actor.profile&rkey=self`
      const res = await fetch(u)
      if (!res.ok) return undefined
      const v = (await res.json() as any)?.value
      if (!v || typeof v !== 'object') return undefined
      const cid = v.avatar?.ref?.$link
      return {
        displayName: typeof v.displayName === 'string' ? v.displayName : undefined,
        description: typeof v.description === 'string' ? v.description : undefined,
        avatarCid: typeof cid === 'string' ? cid : undefined,
        did: repo,
      }
    },
    async getRecord(rkey, scope) {
      const u = `${origin}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repoDid(scope))}&collection=${encodeURIComponent(COLL)}&rkey=${encodeURIComponent(rkey)}`
      const res = await fetch(u)
      if (res.status === 400 || res.status === 404) return undefined
      if (!res.ok) throw new Error(`getRecord ${res.status}`)
      return (await res.json() as any).value
    },
    async putObject(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=60' }))
    },
    async deleteObject(key) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })) },
    async listIndex(scope) {
      const out = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': idxPk(scope) } }))
      return (out.Items || []).map(i => i.item)
    },
    async getIndex(rkey, scope) {
      const out = await ddb.send(new GetCommand({ TableName: table, Key: { pk: idxPk(scope), sk: rkey } }))
      return out.Item?.item
    },
    async putIndex(item, scope) {
      await ddb.send(new PutCommand({ TableName: table, Item: { pk: idxPk(scope), sk: item.rkey, item } }))
    },
    async ownerOf(slug, scope) {
      const out = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': idxPk(scope) } }))
      const hit = (out.Items || []).map(i => i.item).find((it: any) => it.currentSlug === slug && it.status === 'published')
      return hit?.rkey
    },
    async kvsPut(slug, value, scope) { await kvs.send(new PutKeyCommand({ KvsARN: kvsArn, Key: kvsKey(slug, scope), Value: value, IfMatch: await etag() })) },
    async kvsDel(slug, scope) {
      try { await kvs.send(new DeleteKeyCommand({ KvsARN: kvsArn, Key: kvsKey(slug, scope), IfMatch: await etag() })) }
      catch (e: any) { if (e?.name !== 'ResourceNotFoundException') throw e }
    },
    async syndicate(post, scope) {
      const u = `${origin}/xrpc/com.atproto.repo.createRecord`
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessJwt(scope)}` }, body: JSON.stringify({ repo: repoDid(scope), collection: 'app.bsky.feed.post', record: post }) })
      if (!res.ok) throw new Error(`syndicate ${res.status} ${await res.text()}`)
      const j = await res.json() as any
      return { uri: j.uri, cid: j.cid }
    },
    async deleteSyndication(uri, scope) {
      const rkey = uri.split('/').pop()!
      const res = await fetch(`${origin}/xrpc/com.atproto.repo.deleteRecord`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessJwt(scope)}` },
        body: JSON.stringify({ repo: repoDid(scope), collection: 'app.bsky.feed.post', rkey }),
      })
      if (!res.ok) throw new Error(`deleteSyndication ${res.status} ${await res.text()}`)
    },
  }
}
