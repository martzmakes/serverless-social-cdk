// engagement.ts — E2 public-AppView engagement reader (Spec #8 / Task 3).
//
// READ-ONLY against the PUBLIC Bluesky AppView (public.api.bsky.app,
// app.bsky.feed.getAuthorFeed). The relay/AppView are the AUTHORITATIVE source
// for like/repost/reply counts; the PDS NEVER emits or depends on engagement.
// This module performs NO PDS write and is never on a PDS code path.
//
// ZERO PII: getAuthorFeed returns aggregate counts only. We surface ONLY the
// public post URI, the three absolute counts, and the joined article slug.
// We NEVER read, request, or store the likers/reposters list or any user
// identifier/handle — counts only.
//
// ARTICLE-SLUG JOIN: a Spec-#1 syndication post is an `app.bsky.feed.post`
// whose `embed.external.uri` is `https://serverless.social/<slug>` (see
// pds/longform-syndication.ts buildBlueskySyndication). We recover the slug by
// parsing that URL and validating it with the SAME read-only `isReserved`
// single-source-of-truth that log-parse.ts uses — exact reserved-path parity:
// host must be `serverless.social`, exactly one path segment, NOT reserved;
// otherwise slug = null.
//
// No new dependency: `node:url` (URL) + read-only imports of the shared
// `isReserved` (longform-routing.ts) and the project-wide `FetchLike` fetch
// contract (pds/blob-import.ts) — reused verbatim, NOT redefined.

import { isReserved } from '../pds/longform-routing'
import type { FetchLike } from '../pds/blob-import'

export type EngageSnapshot = {
  uri: string
  likes: number
  reposts: number
  replies: number
  slug: string | null
}

// The apex site host that a syndication post's embed.external.uri points at
// (matches RenderCtx.origin host used by buildBlueskySyndication, and the
// "real top-level <slug>" rule log-parse.ts/longform-edge.js decide by).
const SITE_HOST = process.env.DOMAIN ?? 'serverless.social'

/**
 * Parse a syndication post's external embed URI into a real, single-segment,
 * non-reserved article slug — or `null`. Mirrors how Phase-D log-parse decides
 * a real slug: host must be `serverless.social`, exactly one path segment, and
 * NOT reserved (reuse the shared read-only `isReserved` — same source). Defends
 * against the `embed.record.external` shape too. Never throws.
 */
function parseSlug(post: any): string | null {
  const rawUri: unknown =
    post?.embed?.external?.uri ?? post?.embed?.record?.external?.uri
  if (typeof rawUri !== 'string' || rawUri === '') return null
  let url: URL
  try {
    url = new URL(rawUri)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== SITE_HOST) return null
  const slug = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!slug || slug.includes('/')) return null
  if (isReserved(slug)) return null
  return slug
}

/**
 * Pure: map a getAuthorFeed body to per-post EngageSnapshot[]. No I/O.
 * `(feed?.feed ?? [])`; per entry `p = it?.post ?? {}`; entries with no
 * `p.uri` are skipped (never throw). Counts default to 0; slug via parseSlug
 * (defaults null). These are the AppView's ABSOLUTE counts (not deltas).
 */
export function snapshotEngagement(feed: any): EngageSnapshot[] {
  const out: EngageSnapshot[] = []
  for (const it of feed?.feed ?? []) {
    const p = it?.post ?? {}
    if (!p.uri) continue
    out.push({
      uri: p.uri,
      likes: p.likeCount ?? 0,
      reposts: p.repostCount ?? 0,
      replies: p.replyCount ?? 0,
      slug: parseSlug(p),
    })
  }
  return out
}

// Defensive page cap: a misbehaving AppView returning an ever-advancing cursor
// must not drive an unbounded loop. Mirrors blob-import.ts's MAX_PAGES guard —
// if the cap is hit while the cursor is STILL advancing we THROW (never
// silently truncate engagement).
const MAX_PAGES = 100

/**
 * Read every post's absolute engagement for `did` by paginating the PUBLIC
 * AppView `app.bsky.feed.getAuthorFeed` (GET, no auth) to exhaustion, flat-
 * mapping each page through snapshotEngagement.
 *
 * Termination is load-bearing: stop on an absent/empty/non-advancing cursor.
 * If the hard MAX_PAGES cap is hit while the cursor is STILL advancing we
 * THROW a clear truncation error rather than silently returning a partial
 * snapshot. Non-ok → throw `getAuthorFeed <status>: <body>`.
 *
 * READ-ONLY (no PDS write); ZERO PII (public post URIs + absolute counts +
 * article slug only — never the likers list). Operates ONLY on the passed
 * `did` (no apex/tenant/A5 coupling). `fetchImpl` reuses the project-wide
 * `FetchLike` contract; defaults to global `fetch`.
 *
 * `opts.maxPosts` (optional, > 0) bounds the read: once that many snapshots
 * are collected, return immediately (sliced to exactly maxPosts) WITHOUT
 * fetching further pages. This lets on-demand callers (e.g. the MCP
 * list_post_engagement tool) cap the work cheaply. Omitted / <= 0 → unbounded
 * exhaustion (the original behavior — every existing caller is unaffected).
 */
export async function readEngagement(
  did: string,
  fetchImpl: FetchLike = fetch as any,
  opts?: { maxPosts?: number },
): Promise<EngageSnapshot[]> {
  const out: EngageSnapshot[] = []
  const maxPosts = opts?.maxPosts && opts.maxPosts > 0 ? opts.maxPosts : undefined
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    let url =
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed` +
      `?actor=${encodeURIComponent(did)}&limit=100`
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`

    const res = await fetchImpl(url)
    if (!res.ok) {
      const detail = res.text ? await res.text() : ''
      throw new Error(`getAuthorFeed ${res.status}: ${detail}`)
    }

    const body: any = res.json ? await res.json() : {}
    for (const snap of snapshotEngagement(body)) out.push(snap)

    // Bounded read: enough collected → stop now (slice to the exact cap), never
    // fetch another page. Checked AFTER appending so a single page can satisfy it.
    if (maxPosts !== undefined && out.length >= maxPosts) return out.slice(0, maxPosts)

    const nextCursor: string | undefined = body?.cursor || undefined
    // Terminate on: no cursor, OR a non-advancing cursor (equal to the one we
    // just sent — a stuck AppView would otherwise loop forever).
    if (!nextCursor || nextCursor === cursor) return out
    cursor = nextCursor
  }

  // Hit the hard cap with an advancing cursor — refuse to silently truncate.
  throw new Error(
    `getAuthorFeed exceeded ${MAX_PAGES}-page cap with an advancing cursor — ` +
      `engagement snapshot is INCOMPLETE; refusing to return a truncated result`,
  )
}

type Doc = { send: (cmd: any) => Promise<any> }

/**
 * Persist each EngageSnapshot as an ABSOLUTE per-day snapshot row (last-write-
 * wins — these are AppView absolute counts, NOT deltas, so a plain PutCommand,
 * never a conditional/ADD). Row:
 *   { pk:'ENGAGE#'+uri, sk:<utcDay>, likes, reposts, replies, slug }
 * sk is today's UTC date (YYYY-MM-DD); re-running the same day overwrites that
 * day's row with the latest absolute counts. Returns the number written.
 *
 * PutCommand is imported lazily so the pure read path
 * (snapshotEngagement/readEngagement, exercised by unit tests with no DDB)
 * never loads the AWS SDK.
 */
export async function upsertEngagement(
  snaps: EngageSnapshot[],
  doc: Doc,
  table: string,
): Promise<number> {
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb')
  const utcDay = new Date().toISOString().slice(0, 10)
  let written = 0
  for (const s of snaps) {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          pk: 'ENGAGE#' + s.uri,
          sk: utcDay,
          likes: s.likes,
          reposts: s.reposts,
          replies: s.replies,
          slug: s.slug,
        },
      }),
    )
    written++
  }
  return written
}

// ── Account-level snapshots (Spec #9 v2) ─────────────────────────────────────
// Follower/follow/post counts over time, captured alongside per-post engagement
// so the MCP get_engagement_trends tool can show account growth. Same ZERO-PII,
// public-AppView, read-only stance as readEngagement — aggregate counts only.

export type AccountSnapshot = { followers: number; follows: number; posts: number }

/**
 * Read one account's aggregate counts from the PUBLIC AppView
 * `app.bsky.actor.getProfile` (GET, no auth). Counts default to 0; non-ok →
 * throw `getProfile <status>: <body>`. ZERO PII (aggregate counts only).
 */
export async function readProfile(
  did: string,
  fetchImpl: FetchLike = fetch as any,
): Promise<AccountSnapshot> {
  const url =
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile` +
    `?actor=${encodeURIComponent(did)}`
  const res = await fetchImpl(url)
  if (!res.ok) {
    const detail = res.text ? await res.text() : ''
    throw new Error(`getProfile ${res.status}: ${detail}`)
  }
  const body: any = res.json ? await res.json() : {}
  return {
    followers: body?.followersCount ?? 0,
    follows: body?.followsCount ?? 0,
    posts: body?.postsCount ?? 0,
  }
}

/**
 * Persist one absolute per-day account snapshot row (last-write-wins plain
 * PutCommand — absolute counts, not deltas):
 *   { pk:'ACCT#'+did, sk:<utcDay>, followers, follows, posts }
 * Re-running the same day overwrites that day's row with the latest counts.
 */
export async function upsertAccountSnapshot(
  did: string,
  snap: AccountSnapshot,
  doc: Doc,
  table: string,
): Promise<void> {
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb')
  const utcDay = new Date().toISOString().slice(0, 10)
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: 'ACCT#' + did,
        sk: utcDay,
        followers: snap.followers,
        follows: snap.follows,
        posts: snap.posts,
      },
    }),
  )
}
