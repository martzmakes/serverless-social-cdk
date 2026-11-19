/**
 * post-engagement.ts — `list_post_engagement` MCP tool (Spec #9 v1).
 *
 * Read-only, on-demand engagement for the caller's own posts. Flow:
 *   1. Validate input (account non-empty string).
 *   2. Resolve caller entitlements (resolveApprovedDids); match `account` arg
 *      against DID or handle. No match → McpToolError('not_entitled'). Same
 *      blast-radius gate as create_post — the tool only reads accounts the
 *      caller is approved for, and always reports the resolved DID back.
 *   3. readEngagement(did, fetch, {maxPosts:limit}) against the PUBLIC Bluesky
 *      AppView (public.api.bsky.app) — reuses the tested Spec #8 reader. ZERO
 *      PII, counts-only, no PDS call, no write.
 *   4. Fold per-post snapshots into a totals summary.
 *
 * NOTE on data source: engagement counts come from Bluesky's AppView and are
 * (a) bsky-only — ActivityPub/Mastodon faves+boosts are not included — and
 * (b) point-in-time absolute counts (not deltas). Trends over time are Spec #9
 * v2 (get_engagement_trends).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

import { resolveApprovedDids } from '../../auth/entitlements'
import { readEngagement, type EngageSnapshot } from '../../analytics/engagement'
import type { FetchLike } from '../../pds/blob-import'
import { McpToolError } from './lib/mcp-tool-error'

export { McpToolError } from './lib/mcp-tool-error'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

// Tests inject a stub fetch; production leaves undefined → global fetch.
export const __testOnly__ = {
  fetchImpl: undefined as FetchLike | undefined,
}

// Deps builder — mirrors list-accounts.ts / create-post.ts env reads.
function buildDeps() {
  return {
    tenantsTable: process.env.TENANTS_TABLE!,
    apexDid:
      process.env.APEX_DID ??
      `did:web:${process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social'}`,
    apexHandle: process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social',
    // `||` (not `??`) so an empty-string env falls through — matches list-accounts.ts.
    allowedEmails: (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ddb,
  }
}

export type ListPostEngagementInput = {
  /** DID or handle from list_accounts. */
  account: string
  /** Optional cap on posts read (newest-first). Omitted → all posts. */
  limit?: number
}

export type EngagementSummary = {
  posts: number
  likes: number
  reposts: number
  replies: number
}

export async function listPostEngagementTool(
  email: string,
  input: ListPostEngagementInput,
): Promise<{ account: string; posts: EngageSnapshot[]; summary: EngagementSummary }> {
  if (!input || typeof input.account !== 'string' || input.account.length === 0) {
    throw new McpToolError('invalid_account')
  }

  const ents = await resolveApprovedDids(email, buildDeps())
  const match = ents.find((e) => e.did === input.account || e.handle === input.account)
  if (!match) throw new McpToolError('not_entitled')

  const limit =
    typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : undefined
  const fetchImpl = (__testOnly__.fetchImpl ?? (fetch as unknown as FetchLike))

  const posts = await readEngagement(match.did, fetchImpl, limit ? { maxPosts: limit } : undefined)

  const summary = posts.reduce<EngagementSummary>(
    (acc, s) => {
      acc.posts += 1
      acc.likes += s.likes
      acc.reposts += s.reposts
      acc.replies += s.replies
      return acc
    },
    { posts: 0, likes: 0, reposts: 0, replies: 0 },
  )

  return { account: match.did, posts, summary }
}
