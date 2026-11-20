import type { ApFollowingStore, FetchJson } from './following'
import { boostKey, noteKey, type ApInboundStore, type TimelineItem } from './ingest'
import { safeHttpsUrl, sanitizeHtml, sanitizePlainText } from './sanitize'

const publicAudience = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public'])
const displayLimit = 24
type Json = Record<string, unknown>
type ThreadReply = TimelineItem & { depth: number }

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value]
const idOf = (value: unknown) => typeof value === 'string' ? value : object(value).id
const originOf = (url: string) => new URL(url).origin
const isPublic = (value: Json) => [...asArray(value.to), ...asArray(value.cc)].some(id => publicAudience.has(String(idOf(id))))

export async function followedPost(
  handle: string, id: string, store: ApInboundStore, following: ApFollowingStore,
): Promise<{ item: TimelineItem; url: string } | undefined> {
  if (!store.get || !safeHttpsUrl(id, 2048)) return
  const record = await store.get(handle, noteKey(id)) ?? await store.get(handle, boostKey(id))
  if (!record || record.item.id !== id || record.ttl <= Math.floor(Date.now() / 1000) ||
    (await following.get(handle, record.owner))?.state !== 'accepted') return
  const url = safeHttpsUrl(record.item.objectId ?? (record.item.boostedBy ? record.item.url : id), 2048)
  if (url) return { item: record.item, url }
}

export async function readPublicPost(url: string, item: TimelineItem, fetchJson: FetchJson) {
  const value = object(await fetchJson(url))
  const id = safeHttpsUrl(value.id, 2048)
  const author = safeHttpsUrl(idOf(value.attributedTo), 2048)
  if (!id || !author || originOf(id) !== originOf(url) || author !== item.actor.id ||
      (!item.boostedBy && id !== item.id) || !['Note', 'Article', 'Question'].includes(String(value.type))) return
  return { value, id, public: isPublic(value) }
}

function cleanReply(input: { id: unknown; url: unknown; actor: unknown; name: unknown; handle: unknown; icon?: unknown; text: unknown; published: unknown; depth: number }): ThreadReply | undefined {
  const id = safeHttpsUrl(input.id, 2048)
  const actorId = safeHttpsUrl(input.actor, 2048)
  if (!id || !actorId || typeof input.text !== 'string' || input.text.length > 50_000 ||
      typeof input.published !== 'string' || !Number.isFinite(Date.parse(input.published))) return
  const actorUrl = new URL(actorId)
  const username = actorUrl.pathname.split('/').filter(Boolean).at(-1)?.replace(/^@/, '')
  return {
    id, url: safeHttpsUrl(input.url) ?? id, actor: {
      id: actorId, name: sanitizePlainText(input.name, 100),
      handle: sanitizePlainText(input.handle, 160) || (username ? `${username}@${actorUrl.hostname}` : actorUrl.hostname),
      icon: safeHttpsUrl(input.icon),
    },
    content: sanitizeHtml(input.text), published: input.published, attachments: [], depth: input.depth,
  }
}

async function mastodonReplies(id: string, fetchJson: FetchJson): Promise<{ items: ThreadReply[]; partial: boolean } | undefined> {
  const post = new URL(id)
  const localId = /^\/users\/[^/]+\/statuses\/(\d{1,30})$/.exec(post.pathname)?.[1]
  if (!localId) return
  // Look up the public context on the same host as the validated object.
  const data = object(await fetchJson(`${post.origin}/api/v1/statuses/${localId}/context`))
  if (!Array.isArray(data.descendants)) return
  const rows = data.descendants.slice(0, displayLimit).map(object)
  const depths = new Map<string, number>([[localId, -1]])
  const items = rows.flatMap(row => {
    if (typeof row.id !== 'string' || typeof row.in_reply_to_id !== 'string' ||
      !['public', 'unlisted'].includes(String(row.visibility))) return []
    const parentDepth = depths.get(row.in_reply_to_id)
    if (parentDepth === undefined || depths.has(row.id)) return []
    const depth = parentDepth + 1
    const account = object(row.account)
    const item = cleanReply({ id: row.uri, url: row.url, actor: account.uri ?? account.url,
      name: account.display_name, handle: account.acct, icon: account.avatar, text: row.content, published: row.created_at, depth })
    if (!item) return []
    depths.set(row.id, depth)
    return [item]
  })
  return { items, partial: data.descendants.length > rows.length }
}

export async function publicReplies(root: NonNullable<Awaited<ReturnType<typeof readPublicPost>>>, fetchJson: FetchJson) {
  if (!root.public) return { items: [], partial: true }
  const mastodon = await mastodonReplies(root.id, fetchJson).catch(() => undefined)
  if (mastodon) return mastodon
  // ActivityPub servers can return a collection object, a collection URL,
  // or a collection whose first page must be resolved separately.
  let collection = object(root.value.replies)
  const collectionId = safeHttpsUrl(typeof root.value.replies === 'string' ? root.value.replies : undefined)
  if (collectionId && originOf(collectionId) === originOf(root.id)) collection = object(await fetchJson(collectionId))
  const first = safeHttpsUrl(idOf(collection.first))
  if (first && originOf(first) === originOf(root.id)) collection = object(await fetchJson(first))
  else if (Object.keys(object(collection.first)).length) collection = object(collection.first)
  const entries = asArray(collection.orderedItems ?? collection.items)
  const candidates = await Promise.allSettled(entries.slice(0, 12).map(async entry => {
    const id = safeHttpsUrl(idOf(entry), 2048)
    if (!id) return
    // Fetch the referenced reply from its own origin so the collection
    // cannot forge another server's actor or comment.
    const reply = object(await fetchJson(id))
    if (reply.id !== id || idOf(reply.inReplyTo) !== root.id || !isPublic(reply)) return
    return cleanReply({ id, url: idOf(reply.url) ?? reply.url, actor: idOf(reply.attributedTo),
      text: reply.content, name: undefined, handle: undefined, published: reply.published, depth: 0 })
  }))
  const items = candidates.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  return { items, partial: !!collection.next || entries.length > candidates.length || items.length < entries.length }
}
