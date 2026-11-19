/**
 * entitlements.ts — pure helper to resolve approved DIDs for an email.
 *
 * Queries TenantsTable.byEmail GSI (no Limit) and synthesizes an apex
 * entitlement for emails in `allowedEmails`. Returns Entitlement[] sorted
 * apex-first (admin synthesis), then tenant rows by createdAt ascending.
 * Filters out non-`active` tenant rows. Dedupes if admin's email has a
 * tenant row matching the apex DID.
 *
 * Replaces (logically) the Limit:1 + admin short-circuit choke point in
 * auth/pds-session.ts.
 */

import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'

export type Entitlement = {
  did: string
  handle: string
  role: 'admin' | 'owner'
}

export type ResolveDeps = {
  tenantsTable: string
  apexDid: string
  apexHandle: string
  allowedEmails: string[]
  ddb: DynamoDBDocumentClient
}

export async function resolveApprovedDids(
  email: string,
  deps: ResolveDeps,
): Promise<Entitlement[]> {
  const out: Entitlement[] = []
  const seen = new Set<string>()

  if (deps.allowedEmails.includes(email)) {
    out.push({ did: deps.apexDid, handle: deps.apexHandle, role: 'admin' })
    seen.add(deps.apexDid)
  }

  const res = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.tenantsTable,
      IndexName: 'byEmail',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email },
    }),
  )
  const items = (res.Items ?? []) as Array<{
    did: string
    handle: string
    status: string
    createdAt?: number
  }>

  const active = items
    .filter((it) => it.status === 'active')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  for (const it of active) {
    if (seen.has(it.did)) continue
    out.push({ did: it.did, handle: it.handle, role: 'owner' })
    seen.add(it.did)
  }

  return out
}
