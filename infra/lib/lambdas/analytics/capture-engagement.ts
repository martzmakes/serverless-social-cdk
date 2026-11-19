// capture-engagement.ts — Spec #9 v2 scheduled engagement/account snapshot.
//
// Runs daily (EventBridge) and finally POPULATES the dormant Spec #8
// PostAnalyticsTable time-series: per-post ENGAGE#<uri>/<day> rows + per-account
// ACCT#<did>/<day> rows. READ-ONLY against the PUBLIC Bluesky AppView (zero PII,
// aggregate counts only) — the only writes are our own aggregate rows. Never on
// a PDS code path; apex byte-lock untouched.
//
// Per-account failures are ISOLATED (one bad/empty account never aborts the
// batch) — e.g. leftover migproof rows have no AppView profile and just log+skip.

import { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

import {
  readEngagement,
  upsertEngagement,
  readProfile,
  upsertAccountSnapshot,
} from './engagement'
import type { FetchLike } from '../pds/blob-import'

type Doc = { send: (cmd: any) => Promise<any> }

export type CaptureDeps = {
  doc: Doc
  table: string
  fetchImpl?: FetchLike
}

/**
 * Snapshot ONE account: per-post engagement (ENGAGE# rows) + the account-level
 * follower/follow/post counts (ACCT# row). Throws on AppView failure so the
 * caller (runCapture) can isolate it per-account.
 */
export async function captureForDid(
  did: string,
  deps: CaptureDeps,
): Promise<{ did: string; posts: number }> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike)
  const snaps = await readEngagement(did, fetchImpl)
  const posts = await upsertEngagement(snaps, deps.doc, deps.table)
  const profile = await readProfile(did, fetchImpl)
  await upsertAccountSnapshot(did, profile, deps.doc, deps.table)
  return { did, posts }
}

export type ResolveDeps = { doc: Doc; tenantsTable: string; apexDid: string }

/**
 * The accounts to snapshot: the apex DID + every `active` tenant DID. Bounded
 * `status='active'` Scan of the (tiny, single-author) TenantsTable; apex is
 * always included and deduped.
 */
export async function resolveCaptureDids(deps: ResolveDeps): Promise<string[]> {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb')
  const res = await deps.doc.send(
    new ScanCommand({
      TableName: deps.tenantsTable,
      FilterExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'active' },
    }),
  )
  const dids = new Set<string>([deps.apexDid])
  for (const it of (res?.Items ?? []) as Array<{ did?: string }>) {
    if (it?.did) dids.add(it.did)
  }
  return [...dids]
}

export type CaptureSummary = {
  accounts: number
  ok: number
  failed: number
  postsWritten: number
}

/**
 * Capture every did, ISOLATING per-account failures (one bad account logs +
 * is counted as failed, never aborts the batch). `capture` is injectable for
 * tests; production uses captureForDid.
 */
export async function runCapture(
  dids: string[],
  deps: CaptureDeps,
  capture: (did: string, deps: CaptureDeps) => Promise<{ did: string; posts: number }> = captureForDid,
): Promise<CaptureSummary> {
  let ok = 0
  let failed = 0
  let postsWritten = 0
  for (const did of dids) {
    try {
      const r = await capture(did, deps)
      ok++
      postsWritten += r.posts
    } catch (e) {
      failed++
      console.error('[capture-engagement] account failed', {
        did,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return { accounts: dids.length, ok, failed, postsWritten }
}

// EventBridge-scheduled entry point. Thin: env → deps → resolve → run.
export const handler: APIGatewayProxyHandlerV2 = async () => {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const table = process.env.POST_ANALYTICS_TABLE!
  const tenantsTable = process.env.TENANTS_TABLE!
  const apexDid =
    process.env.APEX_DID ?? `did:web:${process.env.DOMAIN ?? 'serverless.social'}`

  const dids = await resolveCaptureDids({ doc, tenantsTable, apexDid })
  const summary = await runCapture(dids, { doc, table })
  console.log('[capture-engagement] done', summary)
  return { statusCode: 200, body: JSON.stringify(summary) }
}
