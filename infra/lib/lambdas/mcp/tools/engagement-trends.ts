/**
 * engagement-trends.ts — `get_engagement_trends` MCP tool (Spec #9 v2).
 *
 * Reads the time-series the daily capture Lambda accumulates in
 * PostAnalyticsTable:
 *   - `uri` given  → per-post series from ENGAGE#<uri>/<day> rows
 *                    (likes/reposts/replies), with a cross-DID uri_mismatch gate
 *                    (mirrors delete_record).
 *   - `uri` omitted → account series from ACCT#<did>/<day> rows
 *                    (followers/follows/posts).
 * Both windowed by optional inclusive since/until (YYYY-MM-DD, lexicographic ==
 * chronological) and returned sorted ascending + a first→last `delta`.
 *
 * Read-only DDB; entitlement-gated against the caller's approved accounts.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'

import { resolveApprovedDids } from '../../auth/entitlements'
import { McpToolError } from './lib/mcp-tool-error'

export { McpToolError } from './lib/mcp-tool-error'

type Doc = { send: (cmd: any) => Promise<any> }

const ddb: Doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))

// Tests inject a doc returning fixture rows; production uses the real client.
export const __testOnly__ = {
  doc: undefined as Doc | undefined,
}

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

export type EngagementTrendsInput = {
  account: string
  /** Optional post AT-URI; omit for account-level (follower) trends. */
  uri?: string
  /** Inclusive YYYY-MM-DD window bounds. */
  since?: string
  until?: string
}

function didFromUri(uri: string): string | null {
  const m = /^at:\/\/([^/]+)\//.exec(uri)
  return m ? m[1] : null
}

function inWindow(day: string, since?: string, until?: string): boolean {
  if (since && day < since) return false
  if (until && day > until) return false
  return true
}

function delta<K extends string>(
  series: Array<Record<K, number> & { day: string }>,
  keys: K[],
): Record<K, number> {
  const out = {} as Record<K, number>
  for (const k of keys) {
    if (series.length === 0) out[k] = 0
    else out[k] = (series[series.length - 1][k] ?? 0) - (series[0][k] ?? 0)
  }
  return out
}

const byDay = (a: { day: string }, b: { day: string }) =>
  a.day < b.day ? -1 : a.day > b.day ? 1 : 0

export async function getEngagementTrendsTool(
  email: string,
  input: EngagementTrendsInput,
) {
  if (!input || typeof input.account !== 'string' || input.account.length === 0) {
    throw new McpToolError('invalid_account')
  }

  const ents = await resolveApprovedDids(email, buildDeps())
  const match = ents.find((e) => e.did === input.account || e.handle === input.account)
  if (!match) throw new McpToolError('not_entitled')

  const doc = __testOnly__.doc ?? ddb
  const table = process.env.POST_ANALYTICS_TABLE!

  if (input.uri) {
    if (didFromUri(input.uri) !== match.did) {
      throw new McpToolError('uri_mismatch', { account: match.did, uri: input.uri })
    }
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'ENGAGE#' + input.uri },
      }),
    )
    const series = ((res?.Items ?? []) as any[])
      .filter((it) => inWindow(it.sk, input.since, input.until))
      .map((it) => ({
        day: it.sk as string,
        likes: Number(it.likes) || 0,
        reposts: Number(it.reposts) || 0,
        replies: Number(it.replies) || 0,
      }))
      .sort(byDay)
    return {
      account: match.did,
      uri: input.uri,
      series,
      delta: delta(series, ['likes', 'reposts', 'replies']),
    }
  }

  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'ACCT#' + match.did },
    }),
  )
  const series = ((res?.Items ?? []) as any[])
    .filter((it) => inWindow(it.sk, input.since, input.until))
    .map((it) => ({
      day: it.sk as string,
      followers: Number(it.followers) || 0,
      follows: Number(it.follows) || 0,
      posts: Number(it.posts) || 0,
    }))
    .sort(byDay)
  return {
    account: match.did,
    series,
    delta: delta(series, ['followers', 'follows', 'posts']),
  }
}
