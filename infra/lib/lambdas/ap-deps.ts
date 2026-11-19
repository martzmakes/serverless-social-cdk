/**
 * ap-deps.ts — AWS/network-backed ApDeps construction for the AP Lambda.
 *
 * DELIBERATELY OUTSIDE infra/lib/lambdas/ap/** : the cardinal-rule guard
 * (apex-nonregression G2(c)) forbids any ap/** file from importing the AT
 * storage/repo-write/sequencer modules. The pure dispatch in ap/handler.ts
 * depends only on the injected ApDeps interface; this module is the single
 * place that wires the real DynamoDB / SSM / fetch implementations and is the
 * only AP-side file permitted to touch ../pds/storage (for READ-only outbox
 * projection — it never writes the AT repo/firehose/did.json).
 *
 * POC LIMITATION M1: this module's placement OUTSIDE ap/** is deliberate —
 * it exists solely to satisfy the lexical apex-nonregression G2(c) guard
 * (no ap/** file may import ../pds/storage) while remaining strictly
 * READ-only against the AT repo (listRecords via DynamoRepoStorage). It
 * never opens a write/sequencer path. Revisit if the guard is relaxed.
 *
 * NOTE (M2 — intentional handler<->ap-deps cycle): handler.ts imports
 * makeRealDeps from here and this module imports plain top-level primitives
 * (constants + types) back from handler.ts. The cycle is effect-free at
 * module scope: makeRealDeps() is only invoked inside handler()'s function
 * body, and the symbols imported back (AP_ENV, *_MS/_BYTES/_SECONDS consts,
 * types) are plain primitives evaluated before any call. Do NOT hoist
 * makeRealDeps() to module top level — that would force eager AWS client
 * construction at import and reintroduce a real init-order cycle.
 */

import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import {
  SQSClient,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs'

import { ENV as PDS_ENV } from './pds/lexicons'
import type { TenantStore } from './pds/tenant'
import { DynamoRepoStorage } from './pds/storage'
import {
  listRecords,
  countRecords,
  getRecordByRkey,
  type RecordEntry,
} from './pds/repo-read'
import type { RepoStorage } from '@atproto/repo/dist/storage/types.js'
import { parseDataKey } from '@atproto/repo'
import { loadRepoOrThrow } from './pds/repo-root'
import { normalizeCidsToIpldJson } from './pds/lex-json'
import { APEX_DID } from './pds/tenant-keys'
import { verifyXrpcAuth } from './pds/access-verify'
import type { ApFollowingStore, FollowingRow } from './ap/following'
import type { ApInboundStore, InboundRecord } from './ap/ingest'
import { safeSlug } from './pds/longform-routing'
import type { IndexItem } from './pds/longform-index'
import type { AtLongform } from './ap/translate'

import { apKeyRef, getOrMintApKey } from './ap/keys'
import { parseCustomHosts } from './ap/host'
import type { ApProfile } from './ap/actor'
import { verifyRequest, signRequest } from './ap/httpsig'
// M2: intentional cycle — these are plain top-level primitives (consts/types)
// from handler.ts; safe because makeRealDeps() runs only inside handler().
import {
  AP_ENV,
  ACTOR_CACHE_TTL_SECONDS,
  REMOTE_FETCH_TIMEOUT_MS,
  REMOTE_FETCH_MAX_BYTES,
  type ApDeps,
  type ApFollowersStore,
  type ApActorCache,
  type RemoteActor,
} from './ap/handler'

const ssm = new SSMClient({})
const sqs = new SQSClient({})

function makeTenantStore(): TenantStore {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env[PDS_ENV.TENANTS_TABLE]!
  return {
    async byDid(did: string) {
      const res = await ddb.send(
        new GetCommand({ TableName: table, Key: { did } }),
      )
      return res.Item ?? null
    },
    async byHandle(handle: string) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byHandle',
          KeyConditionExpression: 'handle = :h',
          ExpressionAttributeValues: { ':h': handle },
          Limit: 1,
        }),
      )
      return res.Items?.[0] ?? null
    },
    async listActive() {
      const res = await ddb.send(
        new ScanCommand({
          TableName: table,
          FilterExpression: '#s = :a',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':a': 'active' },
        }),
      )
      return (res.Items ?? []) as Array<{ did: string }>
    },
  }
}

function makeFollowersStore(): ApFollowersStore {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env[AP_ENV.AP_FOLLOWERS_TABLE]!
  return {
    async add(handle, actorId, inbox) {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: { pk: handle, sk: actorId, inbox, addedAt: Date.now() },
        }),
      )
    },
    async remove(handle, actorId) {
      await ddb.send(
        new DeleteCommand({
          TableName: table,
          Key: { pk: handle, sk: actorId },
        }),
      )
    },
    async list(handle) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :h',
          ExpressionAttributeValues: { ':h': handle },
        }),
      )
      return (res.Items ?? []).map((i: any) => i.sk as string)
    },
  }
}

function makeActorCache(): ApActorCache {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env[AP_ENV.AP_ACTOR_CACHE_TABLE]!
  return {
    async get(actorId) {
      const res = await ddb.send(
        new GetCommand({ TableName: table, Key: { pk: actorId } }),
      )
      const item = res.Item as any
      if (!item) return null
      // Honor TTL defensively in case the DDB TTL sweep lags.
      if (item.ttl && item.ttl * 1000 < Date.now()) return null
      return { publicKeyPem: item.publicKeyPem, inbox: item.inbox }
    },
    async put(actorId, publicKeyPem, inbox, ttl) {
      const ttlEpoch =
        Math.floor(Date.now() / 1000) + (ttl ?? ACTOR_CACHE_TTL_SECONDS)
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: { pk: actorId, publicKeyPem, inbox, ttl: ttlEpoch },
        }),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// SSRF guard (ATTACKER-FACING — the keyId AND the follower inbox URL are fully
// attacker-controlled via the inbound Signature header / Follow activity).
//
// Without this, a remote could point the Lambda at the EC2/Lambda IMDS
// (169.254.169.254), RFC1918 / loopback / link-local / CGNAT / .internal
// hosts and exfiltrate credentials or pivot. We resolve the host via DNS and
// reject if ANY resolved address (or a literal-IP host) falls in a blocked
// range, before any connection is made.
//
// DNS-REBINDING RESIDUAL (documented, accepted for this POC): the ideal fix
// pins the validated IP into the connection via an undici
// `Agent({ connect: { lookup }})` / custom dispatcher. The `undici` package
// is NOT resolvable in this build (Node 22 ships undici as global fetch but
// does NOT expose `node:undici`, and we must not add a dependency), and Node
// global fetch offers no public per-request `lookup` hook. So we use
// resolve→validate→fetch with `redirect:'manual'` (manual redirect already
// prevents a redirect-based pivot). The residual is a TOCTOU window: between
// our `assertSafeRemoteUrl` lookup and global fetch's own internal DNS
// resolution an attacker controlling the authoritative DNS could rebind the
// hostname to a blocked IP. The non-rebinding case (literal IMDS/RFC1918 IPs,
// or a host whose DNS is static) is fully blocked, which is the mandatory
// requirement here. Closing the rebind residual requires the pinned-lookup
// dispatcher and is tracked for when `undici` is wired.
// ---------------------------------------------------------------------------

/** Injectable DNS resolver (default = node:dns/promises lookup). Tests override. */
export type DnsLookupAll = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>

const defaultDnsLookupAll: DnsLookupAll = async (host) => {
  const res = await dnsLookup(host, { all: true })
  return res.map((r) => ({ address: r.address, family: r.family }))
}

/** Expand an IPv6 literal to its 8 16-bit groups (null if unparseable). */
function expandIpv6(addr: string): number[] | null {
  let a = addr.toLowerCase()
  // Embedded dotted-quad tail (::ffff:1.2.3.4) -> two hex groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map((n) => parseInt(n, 10))
    if (o.some((n) => n > 255)) return null
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return out.some(Number.isNaN) ? null : out
}

/** True if the dotted IPv4 `a.b.c.d` is in a blocked range. */
function isBlockedIpv4(o: number[]): boolean {
  if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b, c] = o
  if (a === 0) return true // 0.0.0.0/8 (incl. unspecified)
  if (a === 127) return true // loopback 127.0.0.0/8
  if (a === 10) return true // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local 169.254/16 (IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/** True if `addr` (a literal IPv4 or IPv6) is in a blocked SSRF range. */
export function isBlockedIp(addrRaw: string): boolean {
  const addr = addrRaw.replace(/^\[|\]$/g, '')
  const v = isIP(addr)
  if (v === 4) return isBlockedIpv4(addr.split('.').map((n) => parseInt(n, 10)))
  if (v === 6) {
    const g = expandIpv6(addr)
    if (!g) return true // unparseable: fail closed
    const embedded = (hi: number, lo: number) =>
      isBlockedIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
    // :: and ::1
    if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true
    // IPv4-mapped ::ffff:a.b.c.d. NOTE: new URL('https://[::ffff:127.0.0.1]/')
    // normalizes the host to the HEX form ::ffff:7f00:1, so the groups (not a
    // dotted-quad regex) must be inspected.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7])
    // IPv4-compatible ::a.b.c.d (deprecated)
    if (g.slice(0, 6).every((x) => x === 0)) return embedded(g[6], g[7])
    // NAT64 64:ff9b::/96
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return embedded(g[6], g[7])
    }
    // 6to4 2002::/16 embeds the v4 address in groups 1-2
    if (g[0] === 0x2002) return embedded(g[1], g[2])
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
    return false
  }
  return false // not an IP literal
}

/**
 * Reject a URL that is non-https, or whose host is (or resolves to) a blocked
 * SSRF target. Applied to BOTH the remote-actor fetch and the delivery POST.
 * Throws on any violation. See the DNS-rebinding residual note above.
 */
export async function assertSafeRemoteUrl(
  urlString: string,
  lookupAll: DnsLookupAll = defaultDnsLookupAll,
): Promise<void> {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    throw new Error('url is not parseable')
  }
  if (url.protocol !== 'https:') {
    throw new Error('refusing non-https url')
  }
  // url.hostname strips the [] from an IPv6 literal already.
  // URL.hostname KEEPS the [] around an IPv6 literal — strip them so the
  // isIP / isBlockedIp checks see the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('url has no host')

  // .internal (and friends) never resolve publicly — block by name too.
  if (/\.internal$/i.test(host) || host.toLowerCase() === 'localhost') {
    throw new Error('refusing internal/localhost host')
  }

  // Literal-IP host: validate directly (no DNS, can't be rebound).
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new Error('refusing blocked-range IP host')
    }
    return
  }

  // Hostname: resolve and reject if ANY address is in a blocked range.
  let addrs: Array<{ address: string; family: number }>
  try {
    addrs = await lookupAll(host)
  } catch {
    throw new Error('host DNS resolution failed')
  }
  if (!addrs.length) throw new Error('host did not resolve')
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new Error('host resolves to a blocked-range address')
    }
  }
}

/**
 * Hardened remote-actor fetch. ATTACKER-FACING:
 *  - SSRF guard (https-only + IMDS/RFC1918/loopback/link-local/CGNAT block)
 *  - AbortSignal.timeout — hard wall-clock cap
 *  - response body size cap (read with a limit, abort if exceeded)
 *  - redirect:'manual' — never silently follow to a non-https location
 *  - publicKey.owner host MUST equal the fetched actor id host; inbox https
 */
export async function realFetchRemoteActor(
  keyId: string,
  lookupAll: DnsLookupAll = defaultDnsLookupAll,
): Promise<RemoteActor> {
  let url: URL
  try {
    url = new URL(keyId)
  } catch {
    throw new Error('keyId is not a URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('refusing non-https keyId')
  }
  // SSRF: reject (or DNS-resolve-and-reject) IMDS/RFC1918/loopback/etc.
  await assertSafeRemoteUrl(url.toString(), lookupAll)
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/activity+json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new Error('refusing to follow redirect on actor fetch')
  }
  if (!res.ok) {
    throw new Error(`actor fetch HTTP ${res.status}`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('empty actor response')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > REMOTE_FETCH_MAX_BYTES) {
        await reader.cancel()
        throw new Error('actor response exceeds size cap')
      }
      chunks.push(value)
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  const doc = JSON.parse(buf.toString('utf8'))

  const id: string | undefined =
    typeof doc?.id === 'string' ? doc.id : undefined
  const inbox: string | undefined =
    typeof doc?.inbox === 'string' ? doc.inbox : undefined
  const pk = doc?.publicKey
  const publicKeyPem: string | undefined =
    typeof pk?.publicKeyPem === 'string' ? pk.publicKeyPem : undefined
  const owner: string | undefined =
    typeof pk?.owner === 'string' ? pk.owner : undefined
  if (!id || !inbox || !publicKeyPem) {
    throw new Error('actor doc missing id/inbox/publicKeyPem')
  }
  if (owner && owner !== id) {
    throw new Error('publicKey.owner does not match actor id')
  }
  try {
    if (new URL(inbox).protocol !== 'https:') {
      throw new Error('non-https inbox')
    }
  } catch {
    throw new Error('invalid inbox URL')
  }
  return { id, inbox, publicKeyPem }
}

/**
 * assertSafeRemoteUrl, but a refusal is tagged `permanent` so the delivery
 * layer never retries it (a blocked address stays blocked). DNS failures are
 * the one transient case and stay untagged.
 */
export async function assertSafeRemoteUrlForDelivery(
  urlString: string,
  lookupAll: DnsLookupAll = defaultDnsLookupAll,
): Promise<void> {
  try {
    await assertSafeRemoteUrl(urlString, lookupAll)
  } catch (e: any) {
    if (!/DNS resolution failed|did not resolve/.test(String(e?.message))) {
      e.permanent = true
    }
    throw e
  }
}

export async function realDeliverActivity(
  inboxUrl: string,
  body: Buffer,
  headers: Record<string, string>,
  lookupAll: DnsLookupAll = defaultDnsLookupAll,
): Promise<{ status: number }> {
  // SSRF: the follower inbox URL is attacker-controlled (from the Follow /
  // the fetched actor doc) — same guard as the actor fetch.
  await assertSafeRemoteUrlForDelivery(inboxUrl, lookupAll)
  const res = await fetch(inboxUrl, {
    method: 'POST',
    headers,
    // Buffer extends Uint8Array at runtime, but @types/jsdom (transitively
    // installed via the live-proof harness's jsdom dep) declares a parallel
    // Buffer interface whose `ArrayBufferLike` parameterization conflicts
    // with the global fetch `BodyInit` type. Cast through `BodyInit` to
    // restore the structural match. Runtime semantics unchanged.
    body: body as unknown as BodyInit,
    redirect: 'manual',
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  })
  return { status: res.status }
}

// ---------------------------------------------------------------------------
// Task 11: guarded JSON fetch, following / inbound stores, owner auth
// ---------------------------------------------------------------------------

const MAX_JSON_REDIRECTS = 3

/**
 * GET + parse JSON from a remote server. ATTACKER-INFLUENCED URLs (webfinger
 * host from the owner's input, actor ids and Announce targets from remote
 * activities), so every hop goes through assertSafeRemoteUrl: https only,
 * post-DNS denylist (IMDS/RFC1918/loopback/link-local/CGNAT). Redirects are
 * followed manually, at most MAX_JSON_REDIRECTS, each target re-guarded (a
 * delegated Mastodon domain redirects webfinger to its web host). Wall-clock
 * timeout and the same 256 KB streamed size cap as the actor fetch.
 */
export async function realFetchJson(
  url: string,
  lookupAll: DnsLookupAll = defaultDnsLookupAll,
): Promise<unknown> {
  let current = url
  for (let hop = 0; hop <= MAX_JSON_REDIRECTS; hop++) {
    await assertSafeRemoteUrl(current, lookupAll)
    const res = await fetch(current, {
      method: 'GET',
      headers: {
        accept:
          'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/jrd+json, application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error('redirect without location')
      try {
        current = new URL(loc, current).toString()
      } catch {
        throw new Error('unparseable redirect location')
      }
      continue
    }
    if (!res.ok) throw new Error(`fetch HTTP ${res.status}`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('empty response')
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > REMOTE_FETCH_MAX_BYTES) {
          await reader.cancel()
          throw new Error('response exceeds size cap')
        }
        chunks.push(value)
      }
    }
    return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'))
  }
  throw new Error('too many redirects')
}

type Ddb = { send(cmd: any): Promise<any> }
const isCondFail = (e: any) => e?.name === 'ConditionalCheckFailedException'

/** ApFollowingTable: pk=handle, sk=actorId. */
export function makeFollowingStore(ddb: Ddb, table: string): ApFollowingStore {
  return {
    async get(handle, actorId) {
      const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: handle, sk: actorId } }))
      return r.Item ? rowFromItem(r.Item) : null
    },
    async put(handle, row) {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: stripUndefined({ pk: handle, sk: row.actorId, ...row }),
        }),
      )
    },
    async setAccepted(handle, actorId) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: handle, sk: actorId },
            UpdateExpression: 'SET #s = :a',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':a': 'accepted' },
          }),
        )
        return true
      } catch (e: any) {
        if (isCondFail(e)) return false
        throw e
      }
    },
    async remove(handle, actorId) {
      await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: handle, sk: actorId } }))
    },
    async list(handle) {
      const rows: FollowingRow[] = []
      let key: Record<string, any> | undefined
      do {
        const r = await ddb.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'pk = :h',
            ExpressionAttributeValues: { ':h': handle },
            ExclusiveStartKey: key,
          }),
        )
        for (const i of r.Items ?? []) rows.push(rowFromItem(i))
        key = r.LastEvaluatedKey
      } while (key)
      return rows
    },
  }
}

function stripUndefined<T extends Record<string, any>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function rowFromItem(i: Record<string, any>): FollowingRow {
  return {
    actorId: i.sk,
    inbox: i.inbox,
    followId: i.followId,
    state: i.state,
    acct: i.acct,
    name: i.name,
    icon: i.icon,
    followers: i.followers,
    createdAt: i.createdAt,
  }
}

/**
 * ApInboundPostsTable: pk=handle, sk=key (hash), sortKey (GSI byPublished range),
 * owner, item (map), ttl (90 d).
 */
export function makeInboundStore(ddb: Ddb, table: string): ApInboundStore {
  return {
    async putIfAbsent(handle, rec) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: { pk: handle, sk: rec.key, owner: rec.owner, sortKey: rec.sortKey, item: stripDeep(rec.item), ttl: rec.ttl },
            ConditionExpression: 'attribute_not_exists(sk)',
          }),
        )
        return true
      } catch (e: any) {
        if (isCondFail(e)) return false
        throw e
      }
    },
    async update(handle, key, owner, patch) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: handle, sk: key },
            UpdateExpression: 'SET #i.#c = :c, #i.#a = :a, #i.#u = :u',
            ConditionExpression: '#o = :o',
            ExpressionAttributeNames: { '#i': 'item', '#c': 'content', '#a': 'attachments', '#u': 'url', '#o': 'owner' },
            ExpressionAttributeValues: { ':c': patch.content, ':a': patch.attachments, ':u': patch.url, ':o': owner },
          }),
        )
        return true
      } catch (e: any) {
        if (isCondFail(e)) return false
        throw e
      }
    },
    async remove(handle, key, owner) {
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: table,
            Key: { pk: handle, sk: key },
            ConditionExpression: '#o = :o',
            ExpressionAttributeNames: { '#o': 'owner' },
            ExpressionAttributeValues: { ':o': owner },
          }),
        )
        return true
      } catch (e: any) {
        if (isCondFail(e)) return false
        throw e
      }
    },
    async page(handle, cursor, limit) {
      const r = await ddb.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byPublished',
          KeyConditionExpression: cursor ? 'pk = :h AND sortKey < :c' : 'pk = :h',
          ExpressionAttributeValues: cursor ? { ':h': handle, ':c': cursor } : { ':h': handle },
          ScanIndexForward: false,
          Limit: limit,
        }),
      )
      const records: InboundRecord[] = (r.Items ?? []).map((i: any) => ({
        key: i.sk,
        owner: i.owner,
        sortKey: i.sortKey,
        item: i.item,
        ttl: i.ttl,
      }))
      return {
        records,
        ...(r.LastEvaluatedKey && records.length ? { cursor: records[records.length - 1].sortKey } : {}),
      }
    },
  }
}

/** DynamoDB document client rejects undefined map members unless told to remove them. */
function stripDeep<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

let cachedJwtSecret: Uint8Array | null = null
async function getJwtSecret(): Promise<Uint8Array> {
  if (cachedJwtSecret) return cachedJwtSecret
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env[PDS_ENV.JWT_SECRET_PARAM]!, WithDecryption: true }),
  )
  const value = res.Parameter?.Value
  if (!value) throw new Error('JWT secret SSM param is empty')
  cachedJwtSecret = new TextEncoder().encode(value)
  return cachedJwtSecret
}

/**
 * Owner authenticator: the SAME verification the XRPC surface uses
 * (verifyXrpcAuth -> verifyAccessFor), so the token the SPA already holds from
 * /auth/pds-session works. No DPoP header is ever passed: a DPoP-bound token
 * (cnf.jkt) therefore fails closed; only first-party plain-Bearer tokens pass.
 */
export function makeOwnerAuthenticator(
  store: TenantStore,
  secret: () => Promise<Uint8Array> = getJwtSecret,
): NonNullable<ApDeps['authenticateOwner']> {
  return async (authorization) => {
    if (!authorization) return null
    const id = await verifyXrpcAuth(authorization, undefined, 'GET', '', store, await secret())
    return id?.did ?? null
  }
}

const POST_COLLECTION = 'app.bsky.feed.post'
const LONGFORM_COLLECTION = 'social.serverless.longform'

function repoStorageFor(did: string): DynamoRepoStorage {
  return new DynamoRepoStorage(
    new DynamoDBClient({}),
    process.env[PDS_ENV.REPO_TABLE]!,
    did,
  )
}

// ---------------------------------------------------------------------------
// Longform index access (the renderer's projection of published longforms).
//
// The slug in the index is the ONLY source of truth for a longform's page URL:
// the renderer normalizes the record slug (safeSlug) and suffixes collisions,
// so record.slug can name a page that does not exist. Key layout mirrors
// pds/longform-renderer-aws.ts (apex pk 'IDX', tenant pk `IDX#<did>`, sk rkey,
// attr `item`).
// ---------------------------------------------------------------------------

const idxPk = (did: string): string => (did === APEX_DID ? 'IDX' : `IDX#${did}`)

function indexDdb() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}))
}

async function readIndexItems(did: string): Promise<IndexItem[]> {
  const ddb = indexDdb()
  const table = process.env.LONGFORM_INDEX_TABLE!
  const items: IndexItem[] = []
  let key: Record<string, any> | undefined
  do {
    const out = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': idxPk(did) },
        ExclusiveStartKey: key,
      }),
    )
    for (const i of out.Items ?? []) if (i.item) items.push(i.item as IndexItem)
    key = out.LastEvaluatedKey
  } while (key)
  return items
}

async function readIndexItem(did: string, rkey: string): Promise<IndexItem | null> {
  const out = await indexDdb().send(
    new GetCommand({
      TableName: process.env.LONGFORM_INDEX_TABLE!,
      Key: { pk: idxPk(did), sk: rkey },
    }),
  )
  return (out.Item?.item as IndexItem | undefined) ?? null
}

/**
 * What the outbox needs from the index: which longforms are PUBLISHED (and
 * under what slug), and which feed.post rkeys are the renderer's syndication
 * link posts for them (those are hidden: the Article is the item).
 */
export interface OutboxIndex {
  slugByRkey: Map<string, string>
  suppressedPostRkeys: Set<string>
}

export function outboxIndexFromItems(items: IndexItem[]): OutboxIndex {
  const slugByRkey = new Map<string, string>()
  const suppressedPostRkeys = new Set<string>()
  for (const it of items) {
    if (it.status !== 'published') continue
    slugByRkey.set(it.rkey, it.currentSlug)
    const uri = it.syndication?.bsky?.uri
    const m = typeof uri === 'string' ? /\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri) : null
    if (m) suppressedPostRkeys.add(m[1])
  }
  return { slugByRkey, suppressedPostRkeys }
}

// ---------------------------------------------------------------------------
// Outbox = Articles + Notes, newest first, from TWO MST collections.
//
// CHEAP MERGE (no per-record scan, one scalar cursor):
//  - Both collections are keyed by TID rkeys from the same clock (longform
//    rkeys are backdated TIDs, see pds/tid-backdate.ts), and a TID sorts
//    lexicographically in time order. So "newest first" across collections is
//    simply rkey DESCENDING over the union of the two key lists. No record
//    value is read to order anything.
//  - Both key lists come from MST nodes only (`listWithPrefix`, keys + CIDs):
//    the same cost the single-collection listing already paid, x2.
//  - totalItems is arithmetic on those lists: |posts| - |hidden syndication
//    posts present| + |published articles present|. No value reads, so the
//    count is exact and never double counts a syndication link post.
//  - A page slices the merged list and reads values for ONLY that page.
//  - The cursor is `<tag>|<rkey>` of the last emitted entry (tag 'p' post,
//    'l' longform). The total order is (rkey desc, tag desc), so resume = the
//    first entry strictly after that position - exact even on an rkey tie
//    across collections. A bare rkey (legacy cursor) resumes after that rkey.
// ASSUMPTION: rkey order == time order. A longform with a non-TID rkey would
// sort by its string, i.e. out of place in time but never lost or duplicated.
// Longforms the renderer has not published yet (no index entry) are omitted:
// they have no page, so no valid Article url.
// ---------------------------------------------------------------------------

export const OUTBOX_PAGE_SIZE = 50

type OutboxTag = 'p' | 'l'
interface OutboxEntry {
  tag: OutboxTag
  rkey: string
  key: string
  cid: { toString(): string }
}

async function planOutbox(storage: RepoStorage, index?: OutboxIndex) {
  const { repo } = await loadRepoOrThrow(storage)
  const [posts, longforms] = await Promise.all([
    repo.data.listWithPrefix(POST_COLLECTION + '/'),
    index ? repo.data.listWithPrefix(LONGFORM_COLLECTION + '/') : Promise.resolve([]),
  ])
  const entries: OutboxEntry[] = []
  for (const l of posts) {
    const { rkey } = parseDataKey(l.key)
    if (index?.suppressedPostRkeys.has(rkey)) continue
    entries.push({ tag: 'p', rkey, key: l.key, cid: l.value })
  }
  for (const l of longforms) {
    const { rkey } = parseDataKey(l.key)
    if (!index?.slugByRkey.has(rkey)) continue
    entries.push({ tag: 'l', rkey, key: l.key, cid: l.value })
  }
  entries.sort((a, b) =>
    a.rkey === b.rkey
      ? a.tag < b.tag ? 1 : -1
      : a.rkey < b.rkey ? 1 : -1,
  )
  return { repo, entries }
}

/** true when `e` sorts strictly AFTER the cursor position in the desc order. */
function isAfterCursor(e: OutboxEntry, cursor: string): boolean {
  const bar = cursor.indexOf('|')
  if (bar < 0) return e.rkey < cursor // legacy bare-rkey cursor
  const tag = cursor.slice(0, bar)
  const rkey = cursor.slice(bar + 1)
  if (e.rkey !== rkey) return e.rkey < rkey
  return e.tag < tag
}

/**
 * One page of the outbox: Articles and Notes merged newest-first (see the
 * block comment above). Without `index` only Notes are listed (the original
 * single-collection behavior).
 */
export async function listOutboxFromStorage(
  storage: RepoStorage,
  did: string,
  cursor?: string,
  index?: OutboxIndex,
  limit: number = OUTBOX_PAGE_SIZE,
): ReturnType<ApDeps['listOutbox']> {
  const { repo, entries } = await planOutbox(storage, index)
  let start = 0
  if (cursor) {
    start = entries.findIndex((e) => isAfterCursor(e, cursor))
    if (start === -1) start = entries.length
  }
  const page = entries.slice(start, start + limit)
  const records: Awaited<ReturnType<ApDeps['listOutbox']>>['records'] = []
  for (const e of page) {
    const { collection } = parseDataKey(e.key)
    const raw = await repo.storage.readRecord(e.cid as any)
    records.push({
      uri: `at://${did}/${collection}/${e.rkey}`,
      cid: e.cid.toString(),
      value: normalizeCidsToIpldJson(raw),
      ...(e.tag === 'l' ? { slug: index!.slugByRkey.get(e.rkey) } : {}),
    })
  }
  const out: Awaited<ReturnType<ApDeps['listOutbox']>> = { records }
  if (start + limit < entries.length && page.length > 0) {
    const last = page[page.length - 1]
    out.cursor = `${last.tag}|${last.rkey}`
  }
  return out
}

/** Exact outbox item count (totalItems): merged, de-duplicated, MST keys only. */
export async function countOutboxFromStorage(
  storage: RepoStorage,
  index?: OutboxIndex,
): Promise<number> {
  return (await planOutbox(storage, index)).entries.length
}

/** Point read of one post (MST get; never scans the collection). */
export function getOutboxPostFromStorage(
  storage: RepoStorage,
  did: string,
  rkey: string,
): Promise<RecordEntry | null> {
  return getRecordByRkey(storage, did, POST_COLLECTION, rkey)
}

function toAtLongform(v: any): AtLongform | null {
  if (!v || typeof v.title !== 'string' || typeof v.content !== 'string') return null
  return {
    title: v.title,
    content: v.content,
    slug: typeof v.slug === 'string' ? v.slug : '',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date(0).toISOString(),
    excerpt: typeof v.excerpt === 'string' ? v.excerpt : undefined,
  }
}

/** Point read of a longform record; null when absent or malformed. */
export async function loadLongformFromStorage(
  storage: RepoStorage,
  did: string,
  rkey: string,
): Promise<AtLongform | null> {
  const hit = await getRecordByRkey(storage, did, LONGFORM_COLLECTION, rkey)
  return hit ? toAtLongform(hit.value) : null
}

/**
 * Is this feed.post the renderer's syndication link post for a longform of the
 * same tenant (its external embed points at that longform's canonical page)?
 *
 * Decided from the index first (exact: the post's rkey is the recorded
 * syndication uri, or the embed slug is a current/prior slug of a published
 * item). The index has a hole at first publish: the renderer creates the
 * syndication post BEFORE it writes the index entry (putIndex follows
 * syndicate()), so the stream can deliver the post first. The authoritative
 * fallback is the longform records themselves, which exist before the post:
 * a record whose normalized slug (or its `-2` collision form) is the embed slug.
 */
export async function isSyndicationLinkFrom(args: {
  rkey: string
  embedUri: string
  pageOrigin: string
  indexItems: IndexItem[]
  recordSlugs: () => Promise<string[]>
}): Promise<boolean> {
  let url: URL
  try {
    url = new URL(args.embedUri)
  } catch {
    return false
  }
  if (url.origin !== args.pageOrigin) return false
  const slug = url.pathname.replace(/^\/+|\/+$/g, '')
  if (!slug || slug.includes('/')) return false

  for (const it of args.indexItems) {
    if (it.status !== 'published') continue
    if (it.syndication?.bsky?.uri?.endsWith(`/${POST_COLLECTION}/${args.rkey}`)) return true
    if (it.currentSlug === slug || it.priorSlugs?.includes(slug)) return true
  }
  for (const recSlug of await args.recordSlugs()) {
    const s = safeSlug(recSlug)
    if (s === slug || `${s}-2` === slug) return true
  }
  return false
}

/** blob ref ({$link} after normalization) -> cid string. */
function blobCid(b: any): string | undefined {
  const l = b?.ref?.$link ?? b?.ref?.toString?.()
  return typeof l === 'string' && l && l !== '[object Object]' ? l : undefined
}

/** Point read of app.bsky.actor.profile/self; null when absent (tolerant). */
export async function getProfileFromStorage(
  storage: RepoStorage,
  did: string,
): Promise<ApProfile | null> {
  const hit = await getRecordByRkey(storage, did, 'app.bsky.actor.profile', 'self')
  if (!hit) return null
  const v = hit.value as any
  return {
    displayName: typeof v?.displayName === 'string' ? v.displayName : undefined,
    description: typeof v?.description === 'string' ? v.description : undefined,
    avatarCid: blobCid(v?.avatar),
    avatarMime: typeof v?.avatar?.mimeType === 'string' ? v.avatar.mimeType : undefined,
    bannerCid: blobCid(v?.banner),
    bannerMime: typeof v?.banner?.mimeType === 'string' ? v.banner.mimeType : undefined,
  }
}

export function makeRealDeps(): ApDeps {
  const tenantStore = makeTenantStore()
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })
  return {
    tenantStore,
    getApKey: (handle: string) => getOrMintApKey(apKeyRef(handle), ssm),
    verifyRequest,
    signRequest,
    fetchRemoteActor: realFetchRemoteActor,
    deliverActivity: realDeliverActivity,
    followers: makeFollowersStore(),
    actorCache: makeActorCache(),
    listOutbox: async (did, cursor) =>
      listOutboxFromStorage(
        repoStorageFor(did),
        did,
        cursor,
        outboxIndexFromItems(await readIndexItems(did)),
      ),
    countOutbox: async (did) =>
      countOutboxFromStorage(
        repoStorageFor(did),
        outboxIndexFromItems(await readIndexItems(did)),
      ),
    getOutboxPost: (did, rkey) =>
      getOutboxPostFromStorage(repoStorageFor(did), did, rkey),
    getArticle: async (did, rkey) => {
      const item = await readIndexItem(did, rkey)
      if (!item || item.status !== 'published') return null
      const record = await loadLongformFromStorage(repoStorageFor(did), did, rkey)
      return record ? { record, slug: item.currentSlug } : null
    },
    retryQueue: process.env[AP_ENV.AP_RETRY_QUEUE_URL] ? makeRetryQueue() : undefined,
    customHosts: parseCustomHosts(process.env.AP_CUSTOM_HOSTS),
    getProfile: (did) => getProfileFromStorage(repoStorageFor(did), did),
    following: makeFollowingStore(ddb, process.env[AP_ENV.AP_FOLLOWING_TABLE]!),
    inbound: makeInboundStore(ddb, process.env[AP_ENV.AP_INBOUND_TABLE]!),
    fetchJson: (url) => realFetchJson(url),
    authenticateOwner: makeOwnerAuthenticator(tenantStore),
  }
}

// ---------------------------------------------------------------------------
// Deliver consumer deps (Task 7) — makeDeliverDeps
//
// Constructs the AWS/network-backed DeliverDeps bundle for ap/deliver.ts.
// Kept here (outside ap/**) so the G2 cardinal-rule guard stays GREEN:
// ap/deliver.ts must not import ../pds/storage or ../pds/repo-write directly.
// ---------------------------------------------------------------------------

import type { DeliverDeps } from './ap/deliver'
import { resolveTenant } from './pds/tenant'

/**
 * followers.list for the deliver consumer — returns {actorId, inbox}[] rather
 * than the string[] that ApFollowersStore.list returns. Both read the same
 * ApFollowersTable (pk=handle, sk=actorId, inbox); this variant projects both
 * fields needed for fan-out delivery.
 */
function makeDeliverFollowersStore(): DeliverDeps['followers'] {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env[AP_ENV.AP_FOLLOWERS_TABLE]!
  return {
    async remove(handle: string, actorId: string) {
      await ddb.send(
        new DeleteCommand({ TableName: table, Key: { pk: handle, sk: actorId } }),
      )
    },
    async list(handle: string) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :h',
          ExpressionAttributeValues: { ':h': handle },
        }),
      )
      return (res.Items ?? []).map((i: any) => ({
        actorId: i.sk as string,
        inbox: i.inbox as string,
      }))
    },
  }
}

/**
 * loadPostRecord — reads a single app.bsky.feed.post record value for (did, rkey)
 * via an MST point read (READ-ONLY — never writes the AT repo). Works for any
 * repo size. Returns null if the record is not found or has been deleted.
 */
export async function loadPostRecordFromStorage(
  storage: RepoStorage,
  did: string,
  rkey: string,
): ReturnType<DeliverDeps['loadPostRecord']> {
  const hit = await getOutboxPostFromStorage(storage, did, rkey)
  if (!hit) return null
  const v = hit.value as any
  const embedUri = v?.embed?.external?.uri
  return {
    text: typeof v?.text === 'string' ? v.text : undefined,
    createdAt: typeof v?.createdAt === 'string' ? v.createdAt : undefined,
    facets: Array.isArray(v?.facets) ? v.facets : undefined,
    ...(typeof embedUri === 'string' ? { embed: { external: { uri: embedUri } } } : {}),
  }
}

async function loadPostRecordReal(did: string, rkey: string) {
  return loadPostRecordFromStorage(repoStorageFor(did), did, rkey)
}

/**
 * resolveHandle — resolve a DID to its handle via the tenant store.
 * Apex short-circuits to APEX_HANDLE without a DDB read (mirrors resolveTenant).
 */
function makeResolveHandle(): DeliverDeps['resolveHandle'] {
  const tenantStore = makeTenantStore()
  return async (did: string) => {
    const tenant = await resolveTenant({ did }, tenantStore)
    if (!tenant) return null
    return { handle: tenant.handle }
  }
}

/**
 * postFetch — hardened HTTP POST to a follower inbox.
 *
 * SSRF guard: calls the existing assertSafeRemoteUrl before any connection
 * (https-only, no IMDS/RFC1918/loopback/link-local/CGNAT/internal hosts).
 * Never duplicates the guard — reuses the already-audited function.
 * Returns { status } so the deliver layer can log non-2xx as a delivery failure.
 */
async function postFetchReal(
  url: string,
  opts: { headers: Record<string, string>; body: Buffer },
): Promise<{ status: number }> {
  // SSRF guard — reuses the existing assertSafeRemoteUrl (see ap-deps.ts comment);
  // a refusal is tagged permanent so it is never retried.
  await assertSafeRemoteUrlForDelivery(url)
  const res = await fetch(url, {
    method: 'POST',
    headers: opts.headers,
    // See note in the inbox-post path above re: Buffer→BodyInit cast.
    body: opts.body as unknown as BodyInit,
    redirect: 'manual',
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  })
  return { status: res.status }
}

// ---------------------------------------------------------------------------
// Retry queue (SQS) + idempotency ledger (DynamoDB conditional writes + TTL)
// ---------------------------------------------------------------------------

/** SQS caps DelaySeconds at 900. */
const SQS_MAX_DELAY_SECONDS = 900

export function makeRetryQueue(): DeliverDeps['retryQueue'] {
  const QueueUrl = process.env[AP_ENV.AP_RETRY_QUEUE_URL]!
  return {
    async enqueue(msg, delaySeconds) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: JSON.stringify(msg),
          DelaySeconds: Math.min(SQS_MAX_DELAY_SECONDS, Math.max(0, delaySeconds ?? 0)),
        }),
      )
    },
  }
}

export function makeChangeVisibility(): (
  receiptHandle: string,
  seconds: number,
) => Promise<void> {
  const QueueUrl = process.env[AP_ENV.AP_RETRY_QUEUE_URL]!
  return async (receiptHandle, seconds) => {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    )
  }
}

/** Seconds a claim stays exclusive; > the delivery Lambda timeout (30 s). */
const LEDGER_LEASE_SECONDS = 120
/** Delivered keys are remembered this long (covers stream + SQS redelivery). */
const LEDGER_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Ledger row pk = sha256(`${activityId}|${inbox}`) (bounded key size). claim is
 * a conditional PutItem: it wins only if no row exists or a previous claim's
 * lease expired without completing. complete -> state 'done' (never claimable
 * until the TTL sweep); release -> delete so a retry may claim again.
 */
export function makeDeliveryLedger(): DeliverDeps['ledger'] {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env[AP_ENV.AP_LEDGER_TABLE]!
  const pk = (key: string) => createHash('sha256').update(key).digest('hex')
  const nowSec = () => Math.floor(Date.now() / 1000)
  const ledger: DeliverDeps['ledger'] = {
    async claim(key) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: pk(key),
              state: 'inflight',
              lease: nowSec() + LEDGER_LEASE_SECONDS,
              ttl: nowSec() + LEDGER_TTL_SECONDS,
            },
            ConditionExpression:
              'attribute_not_exists(pk) OR (#s = :inflight AND #l < :now)',
            ExpressionAttributeNames: { '#s': 'state', '#l': 'lease' },
            ExpressionAttributeValues: { ':inflight': 'inflight', ':now': nowSec() },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        )
        return true
      } catch (e: any) {
        if (e?.name === 'ConditionalCheckFailedException') {
          // 'done' = delivered, skip. Anything else is a live (unexpired)
          // lease whose holder has not finished: report it so the caller
          // re-checks instead of assuming the activity went out.
          let state = e?.Item?.state
          if (state && typeof state === 'object') state = state.S // raw AttributeValue
          if (state === undefined) {
            const cur = await ddb.send(
              new GetCommand({ TableName: table, Key: { pk: pk(key) }, ConsistentRead: true }),
            )
            state = cur.Item?.state
            if (!cur.Item) return ledger.claim(key) // vanished between the calls: try again
          }
          return state === 'done' ? false : 'inflight'
        }
        throw e
      }
    },
    async complete(key) {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: pk(key) },
          UpdateExpression: 'SET #s = :done, #t = :ttl',
          ExpressionAttributeNames: { '#s': 'state', '#t': 'ttl' },
          ExpressionAttributeValues: { ':done': 'done', ':ttl': nowSec() + LEDGER_TTL_SECONDS },
        }),
      )
    },
    async release(key) {
      await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: pk(key) } }))
    },
  }
  return ledger
}

export function makeDeliverDeps(): DeliverDeps {
  return {
    resolveHandle: makeResolveHandle(),
    loadPostRecord: loadPostRecordReal,
    loadLongform: (did, rkey) =>
      loadLongformFromStorage(repoStorageFor(did), did, rkey),
    getLongformIndex: async (did, rkey) => {
      const it = await readIndexItem(did, rkey)
      return it ? { slug: it.currentSlug, cid: it.cid, status: it.status } : null
    },
    isSyndicationLink: async (did, rkey, embedUri, pageOrigin) =>
      isSyndicationLinkFrom({
        rkey,
        embedUri,
        pageOrigin,
        indexItems: await readIndexItems(did),
        recordSlugs: async () => {
          const storage = repoStorageFor(did)
          const slugs: string[] = []
          let cursor: string | undefined
          do {
            const page = await listRecords(storage, did, {
              collection: LONGFORM_COLLECTION,
              limit: 100,
              cursor,
            })
            for (const r of page.records) {
              const sl = (r.value as any)?.slug
              if (typeof sl === 'string') slugs.push(sl)
            }
            cursor = page.cursor
          } while (cursor)
          return slugs
        },
      }),
    followers: makeDeliverFollowersStore(),
    ledger: makeDeliveryLedger(),
    retryQueue: makeRetryQueue(),
    getApKey: (handle: string) => getOrMintApKey(apKeyRef(handle), ssm),
    signRequest,
    postFetch: postFetchReal,
    customHosts: parseCustomHosts(process.env.AP_CUSTOM_HOSTS),
  }
}
