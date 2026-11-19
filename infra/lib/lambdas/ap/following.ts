/**
 * ap/following.ts - outbound Follow of remote (Mastodon) actors.
 *
 * Pure: every effect (HTTP fetch behind the SSRF guard, persistence) is an
 * injected port. The owner routes themselves live in ap/handler.ts; this file
 * owns acct parsing, webfinger + actor resolution, activity construction and
 * the view shapes.
 */
import { createHash } from 'node:crypto'

import { safeHttpsUrl, sanitizePlainText } from './sanitize'

export type FollowState = 'pending' | 'accepted'

export interface FollowingRow {
  actorId: string
  inbox: string
  /** Deterministic id of OUR Follow activity (Accept must name it). */
  followId: string
  state: FollowState
  /** user@domain as the owner typed it (validated against the actor doc). */
  acct: string
  /** Plain text, rendered as text by clients. */
  name?: string
  icon?: string
  /** The followee's followers collection (decides followers-only visibility). */
  followers?: string
  createdAt: number
}

/** Following persistence. Row: pk=handle, sk=actorId. */
export interface ApFollowingStore {
  get(handle: string, actorId: string): Promise<FollowingRow | null>
  put(handle: string, row: FollowingRow): Promise<void>
  /** pending -> accepted. false when there is no such row. */
  setAccepted(handle: string, actorId: string): Promise<boolean>
  remove(handle: string, actorId: string): Promise<void>
  list(handle: string): Promise<FollowingRow[]>
}

/** SSRF-guarded GET returning parsed JSON (size capped, redirects re-guarded). */
export type FetchJson = (url: string) => Promise<unknown>

export class FollowResolveError extends Error {}

const USER_RE = /^[A-Za-z0-9._-]{1,64}$/
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** `@user@host`, `acct:user@host` or `user@host` -> parts, else null. */
export function parseAcct(input: unknown): { user: string; domain: string } | null {
  if (typeof input !== 'string' || input.length > 320) return null
  const s = input.trim().replace(/^acct:/i, '').replace(/^@/, '')
  const parts = s.split('@')
  if (parts.length !== 2) return null
  const [user, domainRaw] = parts
  const domain = domainRaw.toLowerCase()
  if (!USER_RE.test(user) || !DOMAIN_RE.test(domain)) return null
  return { user, domain }
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).host.toLowerCase()
  } catch {
    return null
  }
}

export interface ResolvedActor {
  actorId: string
  inbox: string
  acct: string
  name?: string
  icon?: string
  followers?: string
}

const ACTOR_TYPES = new Set(['Person', 'Service', 'Application', 'Group', 'Organization'])
const AP_TYPE = /activity\+json|ld\+json/i

/** The remote actor's display fields (plain text) from its actor document. */
export function actorDisplay(doc: any): { name?: string; icon?: string } {
  const icon = doc?.icon
  const iconUrl = safeHttpsUrl(typeof icon === 'string' ? icon : Array.isArray(icon) ? icon[0]?.url : icon?.url)
  return {
    name: sanitizePlainText(doc?.name, 100) || undefined,
    icon: iconUrl,
  }
}

/**
 * webfinger -> actor document, every fetch through the injected guarded
 * FetchJson. Throws FollowResolveError on anything that does not check out.
 */
export async function resolveActorByAcct(
  acct: { user: string; domain: string },
  fetchJson: FetchJson,
  ownHosts: string[],
): Promise<ResolvedActor> {
  const fail = (m: string): never => {
    throw new FollowResolveError(m)
  }
  if (ownHosts.includes(acct.domain)) fail('that account is on this server')

  let jrd: any
  try {
    const resource = encodeURIComponent(`acct:${acct.user}@${acct.domain}`)
    jrd = await fetchJson(`https://${acct.domain}/.well-known/webfinger?resource=${resource}`)
  } catch (e: any) {
    return fail(`webfinger lookup failed: ${e?.message ?? 'error'}`)
  }
  const self = Array.isArray(jrd?.links)
    ? jrd.links.find(
        (l: any) => l?.rel === 'self' && typeof l.href === 'string' && (!l.type || AP_TYPE.test(l.type)),
      )
    : undefined
  const href = safeHttpsUrl(self?.href)
  if (!href) return fail('webfinger has no ActivityPub actor link')

  let doc: any
  try {
    doc = await fetchJson(href)
  } catch (e: any) {
    return fail(`actor fetch failed: ${e?.message ?? 'error'}`)
  }
  const id = typeof doc?.id === 'string' ? doc.id : ''
  // The actor id host must be the host we fetched (no webfinger pointing at a
  // document that names someone else) and must not be one of ours.
  if (!id || safeHttpsUrl(id) === undefined || hostOf(id) !== hostOf(href)) return fail('actor id mismatch')
  if (ownHosts.includes(hostOf(id)!)) return fail('that account is on this server')
  if (!ACTOR_TYPES.has(doc?.type)) return fail('not an actor')
  if (typeof doc.preferredUsername !== 'string' || doc.preferredUsername.toLowerCase() !== acct.user.toLowerCase()) {
    return fail('username mismatch')
  }
  const inbox = safeHttpsUrl(doc.inbox)
  if (!inbox) return fail('actor has no https inbox')
  const followers = safeHttpsUrl(doc.followers)
  return {
    actorId: id,
    inbox,
    acct: `${acct.user}@${acct.domain}`,
    ...actorDisplay(doc),
    ...(followers ? { followers } : {}),
  }
}

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

/** Deterministic: a retried POST /following re-sends the SAME activity id. */
export function followIdFor(ourActorId: string, targetActorId: string): string {
  return `${ourActorId}#follows/${createHash('sha256').update(targetActorId).digest('hex').slice(0, 24)}`
}

export function buildFollow(ourActorId: string, followId: string, targetActorId: string) {
  return { '@context': AS_CONTEXT, id: followId, type: 'Follow', actor: ourActorId, object: targetActorId }
}

export function buildUndoFollow(ourActorId: string, followId: string, targetActorId: string) {
  return {
    '@context': AS_CONTEXT,
    id: `${followId}/undo`,
    type: 'Undo',
    actor: ourActorId,
    object: { id: followId, type: 'Follow', actor: ourActorId, object: targetActorId },
  }
}

/** Public AP collection: accepted followees only. */
export function publicFollowingCollection(ourActorId: string, rows: FollowingRow[]) {
  const ids = rows.filter((r) => r.state === 'accepted').map((r) => r.actorId)
  return {
    '@context': AS_CONTEXT,
    type: 'OrderedCollection',
    id: `${ourActorId}/following`,
    totalItems: ids.length,
    orderedItems: ids,
  }
}

/** Owner view: states included, delivery details (inbox) never. */
export function ownerFollowingItem(r: FollowingRow) {
  return { id: r.actorId, acct: r.acct, name: r.name, icon: r.icon, state: r.state }
}
