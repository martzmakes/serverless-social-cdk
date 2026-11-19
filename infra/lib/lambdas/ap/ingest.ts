/**
 * ap/ingest.ts - inbound posts from remote actors the owner follows.
 *
 * Trust model (the caller, handleInbox, already verified the HTTP signature
 * and that activity.actor == signer):
 *  - only an ACCEPTED followee's Create / Update / Announce is stored;
 *  - Create/Update: object.attributedTo must equal the signer and the object
 *    id must be an https URL on the signer's host;
 *  - only public / unlisted / followers-visible Notes and Articles are kept,
 *    never a direct message (no as:Public and not the followee's followers
 *    collection in to/cc);
 *  - Announce: the boosted object is FETCHED BY URL (SSRF-guarded, size
 *    capped by the injected fetchJson); an embedded object body is never
 *    trusted, and only a public object is kept;
 *  - Update and Delete are scoped to the signer: the store applies them
 *    conditionally on `owner == signer`;
 *  - all HTML is sanitized (ap/sanitize.ts) BEFORE it is stored.
 *
 * Idempotency: rows are keyed by a hash of the object id (boosts: of the
 * Announce id), written with a conditional put, so a retried delivery stores
 * one item and never overwrites an edit.
 */
import { createHash } from 'node:crypto'

import type { FetchJson, FollowingRow } from './following'
import {
  safeHttpsUrl,
  sanitizeAttachments,
  sanitizeHtml,
  sanitizePlainText,
} from './sanitize'

export interface TimelineActor {
  id: string
  name?: string
  handle: string
  icon?: string
}

export interface TimelineItem {
  /** Object id (Create) or the Announce activity id (boost). */
  id: string
  actor: TimelineActor
  /** Sanitized HTML. */
  content: string
  url: string
  /** ISO-8601 UTC, clamped to the receive time. */
  published: string
  attachments: { url: string; alt: string }[]
  boostedBy?: TimelineActor
}

export interface InboundRecord {
  /** sha256 hex of 'N|<object id>' or 'B|<announce id>'. */
  key: string
  /** Who may update / delete this row: the author (Create) or booster (boost). */
  owner: string
  /** `<published ISO>#<key prefix>`: unique, orders the timeline. */
  sortKey: string
  item: TimelineItem
  /** Epoch seconds (DynamoDB TTL). */
  ttl: number
}

export interface ApInboundStore {
  /** Conditional create. false when the key already exists (duplicate delivery). */
  putIfAbsent(handle: string, rec: InboundRecord): Promise<boolean>
  /** Owner-conditional edit. false when absent or owned by someone else. */
  update(
    handle: string,
    key: string,
    owner: string,
    patch: Pick<TimelineItem, 'content' | 'attachments' | 'url'>,
  ): Promise<boolean>
  /** Owner-conditional delete. */
  remove(handle: string, key: string, owner: string): Promise<boolean>
  /** Newest-first page; `cursor` is the sortKey of the last record returned. */
  page(
    handle: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ records: InboundRecord[]; cursor?: string }>
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const noteKey = (objectId: string) => sha(`N|${objectId}`)
export const boostKey = (announceId: string) => sha(`B|${announceId}`)

export const INBOUND_TTL_SECONDS = 90 * 24 * 60 * 60
/** Raw HTML content cap; over it the item is dropped (never truncated). */
export const MAX_CONTENT_CHARS = 50_000
const MAX_ID_CHARS = 2048
export const CURSOR_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z#[0-9a-f]{16}$/

const PUBLIC_IDS = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public'])
const hostOf = (u: string): string | null => {
  try {
    return new URL(u).host.toLowerCase()
  } catch {
    return null
  }
}

function ids(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
  const out: string[] = []
  for (const x of list) {
    if (typeof x === 'string') out.push(x)
    else if (x && typeof x === 'object' && typeof (x as any).id === 'string') out.push((x as any).id)
  }
  return out
}

function audience(obj: any, activity: any): string[] {
  const own = [...ids(obj?.to), ...ids(obj?.cc)]
  return own.length ? own : [...ids(activity?.to), ...ids(activity?.cc)]
}

/** public / unlisted always; followers-visible only for the followee's own collection. */
function isVisible(aud: string[], followersUrl: string | undefined, allowFollowersOnly: boolean): boolean {
  if (aud.some((a) => PUBLIC_IDS.has(a))) return true
  return allowFollowersOnly && !!followersUrl && aud.includes(followersUrl)
}

function singleId(v: unknown): string | undefined {
  const list = ids(v)
  return list.length === 1 ? list[0] : undefined
}

function validObjectId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_CHARS && safeHttpsUrl(id, MAX_ID_CHARS) !== undefined
}

interface Shaped {
  content: string
  attachments: { url: string; alt: string }[]
  url: string
  published: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function shapeObject(obj: any, now: number): Shaped | null {
  let raw: unknown = obj.content
  if (typeof raw !== 'string' && obj.contentMap && typeof obj.contentMap === 'object') {
    raw = Object.values(obj.contentMap).find((v) => typeof v === 'string')
  }
  if (raw !== undefined && typeof raw !== 'string') return null
  if (typeof raw === 'string' && raw.length > MAX_CONTENT_CHARS) return null
  let content = sanitizeHtml(raw ?? '')
  const title = obj.type === 'Article' ? sanitizePlainText(obj.name, 200) : undefined
  if (title) content = `<p><strong>${esc(title)}</strong></p>${content}`
  const attachments = sanitizeAttachments(obj.attachment)
  if (!content && attachments.length === 0) return null
  const u = obj.url
  const url =
    safeHttpsUrl(typeof u === 'string' ? u : Array.isArray(u) ? (typeof u[0] === 'string' ? u[0] : u[0]?.href) : u?.href) ??
    safeHttpsUrl(obj.id)
  if (!url) return null
  let t = typeof obj.published === 'string' ? Date.parse(obj.published) : NaN
  if (!Number.isFinite(t) || t > now) t = now
  if (t < 0) t = 0
  return { content, attachments, url, published: new Date(t).toISOString() }
}

export type IngestOutcome = 'stored' | 'updated' | 'deleted' | 'ignored'

export interface IngestCtx {
  handle: string
  /** The verified signer (== activity.actor). */
  signerId: string
  /** The signer's following row (null when not followed). */
  followee: FollowingRow | null
  store: ApInboundStore
  fetchJson: FetchJson
  now?: () => number
}

const accepted = (c: IngestCtx) => c.followee?.state === 'accepted'

function actorOf(f: FollowingRow): TimelineActor {
  return { id: f.actorId, name: f.name, handle: f.acct, icon: f.icon }
}

function log(event: string, fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ at: 'ap.ingest', event, ...fields }))
}

/** Common checks for a Create/Update object body. */
function authoredNote(obj: any, c: IngestCtx): obj is Record<string, any> {
  if (!obj || typeof obj !== 'object') return false
  if (obj.type !== 'Note' && obj.type !== 'Article') return false
  if (!validObjectId(obj.id) || hostOf(obj.id) !== hostOf(c.signerId)) return false
  return singleId(obj.attributedTo) === c.signerId
}

export async function ingestCreate(activity: any, c: IngestCtx): Promise<IngestOutcome> {
  if (!accepted(c)) return 'ignored'
  const obj = activity?.object
  if (!authoredNote(obj, c)) return 'ignored'
  if (!isVisible(audience(obj, activity), c.followee!.followers, true)) return 'ignored'
  const now = (c.now ?? Date.now)()
  const shaped = shapeObject(obj, now)
  if (!shaped) return 'ignored'
  const key = noteKey(obj.id)
  const created = await c.store.putIfAbsent(c.handle, {
    key,
    owner: c.signerId,
    sortKey: `${shaped.published}#${key.slice(0, 16)}`,
    item: { id: obj.id, actor: actorOf(c.followee!), ...shaped },
    ttl: Math.floor(now / 1000) + INBOUND_TTL_SECONDS,
  })
  return created ? 'stored' : 'ignored'
}

export async function ingestUpdate(activity: any, c: IngestCtx): Promise<IngestOutcome> {
  if (!accepted(c)) return 'ignored'
  const obj = activity?.object
  if (!authoredNote(obj, c)) return 'ignored'
  const key = noteKey(obj.id)
  if (!isVisible(audience(obj, activity), c.followee!.followers, true)) {
    // edited to a private audience: stop showing it
    return (await c.store.remove(c.handle, key, c.signerId)) ? 'deleted' : 'ignored'
  }
  const shaped = shapeObject(obj, (c.now ?? Date.now)())
  if (!shaped) return 'ignored'
  // owner-conditional: an Update from anyone but the original author misses
  const ok = await c.store.update(c.handle, key, c.signerId, {
    content: shaped.content,
    attachments: shaped.attachments,
    url: shaped.url,
  })
  return ok ? 'updated' : 'ignored'
}

/** Delete of an object (Note / Tombstone / Announce id) by its owner only. */
export async function ingestDelete(activity: any, c: IngestCtx): Promise<IngestOutcome> {
  const id = singleId(activity?.object)
  if (!id || id.length > MAX_ID_CHARS) return 'ignored'
  const a = await c.store.remove(c.handle, noteKey(id), c.signerId)
  const b = await c.store.remove(c.handle, boostKey(id), c.signerId)
  return a || b ? 'deleted' : 'ignored'
}

export async function ingestAnnounce(activity: any, c: IngestCtx): Promise<IngestOutcome> {
  if (!accepted(c)) return 'ignored' // no fetch for strangers
  if (!validObjectId(activity?.id)) return 'ignored'
  const target = singleId(activity.object)
  // Always fetch by URL: an embedded body is attacker-authored.
  if (!target || !validObjectId(target)) return 'ignored'

  let obj: any
  try {
    obj = await c.fetchJson(target)
  } catch (e: any) {
    log('announce_fetch_failed', { handle: c.handle, host: hostOf(target), message: e?.message })
    return 'ignored'
  }
  if (!obj || typeof obj !== 'object') return 'ignored'
  if (obj.type !== 'Note' && obj.type !== 'Article') return 'ignored'
  if (!validObjectId(obj.id) || hostOf(obj.id) !== hostOf(target)) return 'ignored'
  const authorId = singleId(obj.attributedTo)
  if (!authorId || !validObjectId(authorId) || hostOf(authorId) !== hostOf(obj.id)) return 'ignored'
  // We know no followers collection for a stranger: public objects only.
  if (!isVisible(audience(obj, activity), undefined, false)) return 'ignored'
  const now = (c.now ?? Date.now)()
  const shaped = shapeObject(obj, now)
  if (!shaped) return 'ignored'

  let author: TimelineActor = { id: authorId, handle: hostOf(authorId)! }
  try {
    const doc: any = await c.fetchJson(authorId)
    if (doc && doc.id === authorId) {
      const user = typeof doc.preferredUsername === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(doc.preferredUsername) ? doc.preferredUsername : null
      const icon = doc.icon
      author = {
        id: authorId,
        name: sanitizePlainText(doc.name, 100) || undefined,
        handle: user ? `${user}@${hostOf(authorId)}` : hostOf(authorId)!,
        icon: safeHttpsUrl(typeof icon === 'string' ? icon : Array.isArray(icon) ? icon[0]?.url : icon?.url),
      }
    }
  } catch {
    // best effort: the boost still shows with the bare host as handle
  }

  const key = boostKey(activity.id)
  const created = await c.store.putIfAbsent(c.handle, {
    key,
    owner: c.signerId,
    sortKey: `${shaped.published}#${key.slice(0, 16)}`,
    item: { id: activity.id, actor: author, ...shaped, boostedBy: actorOf(c.followee!) },
    ttl: Math.floor(now / 1000) + INBOUND_TTL_SECONDS,
  })
  return created ? 'stored' : 'ignored'
}

export async function ingestActivity(type: string, activity: any, c: IngestCtx): Promise<IngestOutcome> {
  switch (type) {
    case 'Create':
      return ingestCreate(activity, c)
    case 'Update':
      return ingestUpdate(activity, c)
    case 'Delete':
      return ingestDelete(activity, c)
    case 'Announce':
      return ingestAnnounce(activity, c)
    default:
      return 'ignored'
  }
}

export const DEFAULT_TIMELINE_LIMIT = 30
export const MAX_TIMELINE_LIMIT = 50
/** Bound on store pages read to fill one timeline page (unfollowed authors are skipped). */
const MAX_TIMELINE_READS = 5

/**
 * One timeline page, newest first. Items whose owner is no longer an ACCEPTED
 * followee are skipped (an unfollow hides their posts at once; the 90-day TTL
 * removes the rows).
 */
export async function buildTimeline(
  handle: string,
  store: ApInboundStore,
  followees: FollowingRow[],
  cursor: string | undefined,
  limit: number,
): Promise<{ items: TimelineItem[]; cursor?: string }> {
  const allowed = new Set(followees.filter((f) => f.state === 'accepted').map((f) => f.actorId))
  const items: TimelineItem[] = []
  let at = cursor
  for (let reads = 0; reads < MAX_TIMELINE_READS; reads++) {
    const page = await store.page(handle, at, limit)
    for (const r of page.records) {
      at = r.sortKey
      if (!allowed.has(r.owner)) continue
      items.push(r.item)
      if (items.length >= limit) return { items, cursor: r.sortKey }
    }
    if (!page.cursor) return { items }
  }
  // read budget spent on skipped rows: resume after the last row read
  return { items, cursor: at }
}
