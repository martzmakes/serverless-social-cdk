/**
 * site-overview.ts — `get_site_analytics` MCP tool.
 *
 * The same site-wide overview the author workspace shows: human page views for
 * articles, the home page and short-post pages over the last 7, 30 or 90 days
 * against the previous window, top articles and short posts, sources, devices,
 * approximate countries and cities, referrers, and Bluesky follower change.
 * Read-only. The account must be one of the caller's approved accounts.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

import { resolveApprovedDids } from '../../auth/entitlements'
import { buildSiteOverview } from '../../analytics/site-overview'
import { McpToolError } from './lib/mcp-tool-error'

type Doc = { send: (cmd: any) => Promise<any> }
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const __testOnly__ = { doc: undefined as Doc | undefined, now: undefined as number | undefined }

export type SiteOverviewInput = { account: string; days?: number }

export async function getSiteAnalyticsTool(email: string, input: SiteOverviewInput) {
  if (!input || typeof input.account !== 'string' || !input.account) throw new McpToolError('invalid_account')
  const days = input.days ?? 30
  if (days !== 7 && days !== 30 && days !== 90) throw new McpToolError('invalid_days', { allowed: [7, 30, 90] })
  const apexHandle = process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social'
  const apexDid = process.env.APEX_DID ?? `did:web:${apexHandle}`
  const ents = await resolveApprovedDids(email, {
    tenantsTable: process.env.TENANTS_TABLE!,
    apexDid,
    apexHandle,
    allowedEmails: (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean),
    ddb: ddb as DynamoDBDocumentClient,
  })
  const match = ents.find((e) => e.did === input.account || e.handle === input.account)
  if (!match) throw new McpToolError('not_entitled')
  const site = { did: match.did, handle: match.handle, host: match.did === apexDid ? apexHandle : match.handle }
  const overview = await buildSiteOverview({
    ddb: __testOnly__.doc ?? ddb,
    analyticsTable: process.env.POST_ANALYTICS_TABLE!,
    indexTable: process.env.LONGFORM_INDEX_TABLE!,
    apexDid,
    ...(__testOnly__.now !== undefined ? { now: __testOnly__.now } : {}),
  }, site, days)
  return {
    account: match.did,
    host: site.host,
    note: 'Human views only. Countries and cities are approximate: they are where the CloudFront edge that served the page is.',
    ...overview,
  }
}
