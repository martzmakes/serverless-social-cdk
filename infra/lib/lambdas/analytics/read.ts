// read.ts — Task-4 admin-gated post-analytics READ.
//
// The admin-only reader for the Spec-#8 post-analytics rollups. PURE +
// deps-injected (the `doc` DocumentClient + `table` name are passed in), so it
// is fully unit-testable with NO AWS SDK and NO network. The xrpc/PDS
// handler.ts wires it into ONE additive GET `case` (the proven
// com.atproto.sync.listBlobs additive-route precedent) and resolves the
// caller's email via the EXACT same magic-link JWT verify the rest of the auth
// surface uses (auth/lib/jwt.ts:verifyJwt) — NO new auth surface.
//
// ───────────────────────────────────────────────────────────────────────────
// AUTH GATE (load-bearing — must NOT be weaker than auth/me.ts).
// `adminEmail` is the caller's already-verified magic-link email (or null when
// no/invalid token). The admit decision is byte-identical to auth/me.ts /
// auth/pds-session.ts. Anything that is not EXACTLY the configured email (null,
// non-admin, sub-user) → 401 with ZERO data and ZERO DDB call. The DDB query
// is only ever reached AFTER the admin check passes, so a non-admin can never
// leak a single count.
// ───────────────────────────────────────────────────────────────────────────
//
// ───────────────────────────────────────────────────────────────────────────
// DATA MODEL (the Task-2 fix's reader contract — see aggregate.ts header
// "DATA MODEL (Task-4 reader contract)"; the original plan's `referrers` map
// is SUPERSEDED). A single QueryCommand on pk='VIEW#'+slug returns BOTH:
//   • day-total rows  : sk = <utcDay>            → { views, uaHuman, uaBot }
//   • referrer rows   : sk = 'REF#'+day+'#'+host → { count }   (discrete items,
//                                                  NOT a nested map)
// Partition by `sk` prefix: sk.startsWith('REF#') ⇒ referrer row (host =
// everything after the 2nd '#'); else ⇒ day-total row. Roll up:
//   totalViews  = Σ day-total `views`
//   dailyTrend  = [{day, views}] sorted by day asc
//   referrers   = { host: Σ count across the window }
// Engagement rows are keyed by post-URI not slug (engagement.ts:
// { pk:'ENGAGE#'+uri, sk:<utcDay>, likes, reposts, replies, slug }); when
// ?engagement is truthy we do a SECOND bounded `slug`-filtered scan (the
// engagement set is tiny — only the apex's own syndication posts — so this is
// an explicitly bounded filtered read, NOT an unbounded table scan).
// ───────────────────────────────────────────────────────────────────────────
//
// ZERO PII: every value surfaced here is an aggregate count, an eTLD+1
// referrer HOST (host-only, never a full URL/query), a public post URI, or the
// article slug. We never read/return an IP, cookie, handle, or liker identity
// — the upstream rows were already PII-stripped (log-parse.ts / engagement.ts)
// and this reader adds nothing back.



type Doc = { send: (cmd: any) => Promise<any> }

export type AnalyticsReadArgs = {
  /** Caller's already-verified magic-link email, or null if no/invalid token. */
  adminEmail: string | null
  query: Record<string, string>
  doc: Doc
  table: string
  /** Hosts whose per-host partitions are read when ?host= is absent (apex + custom hosts). */
  hosts?: string[]
}

export type AnalyticsReadResult = { status: number; json: any }

/**
 * Admin-gated rollup of the Task-2 VIEW#/REF# (+ optional ENGAGE#) rows for one
 * article slug. Pure: all I/O is through the injected `doc`.
 *
 * - adminEmail !== ADMIN_EMAIL → { 401, {error:'AuthRequired'} } — NO data, NO
 *   DDB call (the gate is checked before anything else).
 * - missing slug → { 400, {error:'InvalidRequest', message:'slug required'} }
 *   (bounded by-slug query only — never an unbounded scan).
 * - admin + slug → { 200, { slug, totalViews, dailyTrend, referrers,
 *   engagement? } }.
 *
 * Optional ?from / ?to (inclusive YYYY-MM-DD) window the day-total + REF# rows
 * by their <day> segment.
 */
export async function analyticsRead(
  args: AnalyticsReadArgs,
): Promise<AnalyticsReadResult> {
  const { adminEmail, query, doc, table, hosts } = args

  // ── AUTH GATE — fail closed BEFORE any DDB call (zero-leak guarantee). ──
  if (!adminEmail || adminEmail !== process.env.ADMIN_EMAIL) {
    return { status: 401, json: { error: 'AuthRequired' } }
  }

  const slug = query.slug
  if (!slug) {
    return {
      status: 400,
      json: { error: 'InvalidRequest', message: 'slug required' },
    }
  }

  const from = query.from || undefined
  const to = query.to || undefined
  // Inclusive window check on a YYYY-MM-DD day (lexicographic == chronological).
  const inWindow = (day: string): boolean => {
    if (from && day < from) return false
    if (to && day > to) return false
    return true
  }

  // SDK imported lazily so the pure path (this fn under unit test with a stub
  // `doc`) never loads the AWS SDK — mirrors engagement.ts:upsertEngagement.
  const { QueryCommand, ScanCommand } = await import('@aws-sdk/lib-dynamodb')

  // ── Legacy pk 'VIEW#'+slug (frozen since the per-host aggregator shipped),
  // plus (Task 17) the per-host pk 'VIEW#'+host+'#'+slug: the one host when
  // ?host= is given, otherwise EVERY known host, so totals keep moving without
  // the caller naming a host. Each Query returns BOTH day-total + REF# rows. ──
  const normHost = (h: string) => h.toLowerCase().trim().replace(/^www\./, '')
  const hostList = query.host ? [query.host] : (hosts ?? [])
  const pks = ['VIEW#' + slug]
  for (const h of new Set(hostList.map(normHost).filter(Boolean))) pks.push('VIEW#' + h + '#' + slug)
  const viewItems: any[] = []
  for (const pk of pks) {
    const r = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
      }),
    )
    viewItems.push(...(r?.Items ?? []))
  }

  let totalViews = 0
  const dailyByDay = new Map<string, number>()
  const dailyTrend: Array<{ day: string; views: number }> = []
  const referrers: Record<string, number> = {}

  for (const it of viewItems) {
    const sk: string = it.sk
    if (typeof sk !== 'string') continue
    if (sk.startsWith('REF#')) {
      // sk = 'REF#'+day+'#'+host  — host is everything after the 2nd '#'
      // (an eTLD+1 host can never itself contain '#', but a defensive
      // join-the-rest keeps any unexpected '#' inside the host bucket rather
      // than dropping the row).
      const rest = sk.slice('REF#'.length)
      const cut = rest.indexOf('#')
      if (cut === -1) continue
      const day = rest.slice(0, cut)
      const host = rest.slice(cut + 1)
      if (!host || !inWindow(day)) continue
      referrers[host] = (referrers[host] ?? 0) + (Number(it.count) || 0)
    } else {
      // day-total row: sk == <utcDay>
      if (!inWindow(sk)) continue
      const views = Number(it.views) || 0
      dailyByDay.set(sk, (dailyByDay.get(sk) ?? 0) + views)
      totalViews += views
    }
  }

  for (const [day, views] of dailyByDay) dailyTrend.push({ day, views })
  dailyTrend.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

  const json: any = { slug, totalViews, dailyTrend, referrers }

  // ── Optional engagement: ENGAGE# rows are keyed by post-URI not slug, so a
  // bounded `slug`-filtered scan (engagement set = only the apex's own
  // syndication posts — tiny by construction; explicitly bounded filtered
  // read, NOT an unbounded table walk). ──
  if (query.engagement) {
    const engRes = await doc.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: 'begins_with(pk, :ep) AND slug = :slug',
        ExpressionAttributeValues: { ':ep': 'ENGAGE#', ':slug': slug },
      }),
    )
    json.engagement = (engRes?.Items ?? []).map((it: any) => ({
      uri: String(it.pk).slice('ENGAGE#'.length),
      likes: Number(it.likes) || 0,
      reposts: Number(it.reposts) || 0,
      replies: Number(it.replies) || 0,
      day: it.sk,
    }))
  }

  return { status: 200, json }
}
