/**
 * page-views.ts — `get_page_views` MCP tool (Task 17).
 *
 * Per-post HUMAN and BOT page views plus human referrers for one of the
 * caller's approved accounts, from the CloudFront-log rollups in
 * PostAnalyticsTable. Read-only.
 *
 * Entitlement wall (same as list_post_engagement / get_engagement_trends):
 * the account is resolved against resolveApprovedDids BEFORE any analytics read;
 * no match -> not_entitled. Only that account's host and index partition are
 * ever read, so a caller cannot see another account's posts.
 *
 * Only slugs that exist (published) in the account's longform index count as
 * post views. Scanner/probe paths (wp-login.php, ...) are written by the
 * aggregator under VIEW#<host>#<slug> but are never queried here. Nothing is
 * deleted.
 *
 * Keys: new data is VIEW#<host>#<slug> (host = account handle, the page host).
 * Legacy VIEW#<slug> rows predate per-host keys and hold traffic for every host,
 * so each account folds them in for its own published slugs.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'

import { resolveApprovedDids } from '../../auth/entitlements'
import { McpToolError } from './lib/mcp-tool-error'

export { McpToolError } from './lib/mcp-tool-error'

type Doc = { send: (cmd: any) => Promise<any> }

const ddb: Doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))

// Tests inject a doc and a clock; production uses the real client and Date.
export const __testOnly__ = {
  doc: undefined as Doc | undefined,
  now: undefined as (() => Date) | undefined,
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 365

function buildDeps() {
  return {
    tenantsTable: process.env.TENANTS_TABLE!,
    apexDid:
      process.env.APEX_DID ??
      `did:web:${process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social'}`,
    apexHandle: process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social',
    allowedEmails: (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ddb: ddb as DynamoDBDocumentClient,
  }
}

export type PageViewsInput = {
  /** DID or handle from list_accounts. */
  account: string
  /** Optional: one post's slug (must be in the longform index). */
  slug?: string
  /** Window length in UTC days ending today, inclusive. Default 30, max 365. */
  days?: number
}

type DayRow = { day: string; humans: number; bots: number }

async function queryAll(doc: Doc, table: string, pk: string): Promise<any[]> {
  const items: any[] = []
  let key: Record<string, any> | undefined
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ...(key ? { ExclusiveStartKey: key } : {}),
      }),
    )
    items.push(...((res?.Items ?? []) as any[]))
    key = res?.LastEvaluatedKey
  } while (key)
  return items
}

const dayStr = (d: Date) => d.toISOString().slice(0, 10)

export async function getPageViewsTool(email: string, input: PageViewsInput) {
  if (!input || typeof input.account !== 'string' || input.account.length === 0) {
    throw new McpToolError('invalid_account')
  }
  let days = DEFAULT_DAYS
  if (input.days !== undefined) {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DAYS) {
      throw new McpToolError('invalid_days', { max: MAX_DAYS })
    }
    days = input.days
  }
  if (input.slug !== undefined && (typeof input.slug !== 'string' || input.slug.length === 0)) {
    throw new McpToolError('invalid_slug')
  }

  // ENTITLEMENT WALL — before any analytics/index read.
  const deps = buildDeps()
  const ents = await resolveApprovedDids(email, deps)
  const match = ents.find((e) => e.did === input.account || e.handle === input.account)
  if (!match) throw new McpToolError('not_entitled')

  const isApex = match.did === deps.apexDid
  const host = match.handle.toLowerCase().replace(/^www\./, '')
  const doc = __testOnly__.doc ?? ddb
  const analytics = process.env.POST_ANALYTICS_TABLE!
  const indexTable = process.env.LONGFORM_INDEX_TABLE!

  const now = (__testOnly__.now ?? (() => new Date()))()
  const until = dayStr(now)
  const since = dayStr(new Date(now.getTime() - (days - 1) * 86_400_000))
  const inWindow = (d: string) => d >= since && d <= until

  // Published slugs for THIS account only (apex pk 'IDX', tenant 'IDX#<did>').
  const idxItems = await queryAll(doc, indexTable, isApex ? 'IDX' : `IDX#${match.did}`)
  const published = new Map<string, string>() // slug -> title
  for (const it of idxItems) {
    const item = it?.item
    if (item?.status === 'published' && typeof item.currentSlug === 'string') {
      published.set(item.currentSlug, typeof item.title === 'string' ? item.title : '')
    }
  }

  let slugs = [...published.keys()]
  if (input.slug !== undefined) {
    if (!published.has(input.slug)) throw new McpToolError('not_found', { slug: input.slug })
    slugs = [input.slug]
  }

  const posts = []
  for (const slug of slugs) {
    const rows = await queryAll(doc, analytics, `VIEW#${host}#${slug}`)
    rows.push(...(await queryAll(doc, analytics, `VIEW#${slug}`))) // legacy
    const byDay = new Map<string, DayRow>()
    const referrers: Record<string, number> = {}
    let humans = 0
    let bots = 0
    for (const r of rows) {
      const sk = r?.sk
      if (typeof sk !== 'string') continue
      if (sk.startsWith('REF#')) {
        const rest = sk.slice(4)
        const cut = rest.indexOf('#')
        if (cut === -1) continue
        const day = rest.slice(0, cut)
        const ref = rest.slice(cut + 1)
        if (!ref || !inWindow(day)) continue
        referrers[ref] = (referrers[ref] ?? 0) + (Number(r.count) || 0)
        continue
      }
      if (!inWindow(sk)) continue
      const h = Number(r.uaHuman ?? r.views) || 0
      const b = Number(r.uaBot) || 0
      const cur = byDay.get(sk) ?? { day: sk, humans: 0, bots: 0 }
      cur.humans += h
      cur.bots += b
      byDay.set(sk, cur)
      humans += h
      bots += b
    }
    const daily = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    posts.push({ slug, title: published.get(slug) ?? '', humans, bots, referrers, daily })
  }
  posts.sort((a, b) => b.humans - a.humans || (a.slug < b.slug ? -1 : 1))

  return {
    account: match.did,
    host,
    window: { days, since, until },
    posts,
    totals: posts.reduce((t, p) => ({ humans: t.humans + p.humans, bots: t.bots + p.bots }), { humans: 0, bots: 0 }),
  }
}
