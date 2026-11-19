/**
 * list-accounts.ts — `list_accounts` MCP tool.
 *
 * Wraps resolveApprovedDids(email, deps) and returns {accounts: Entitlement[]}.
 * Read-only — no PDS calls, just a DDB read via the resolver.
 *
 * Caller (MCP server) is responsible for mapping an empty array to either
 * an MCP error response or an empty UI render — this helper never throws
 * for "unapproved email" / "no entitlements".
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { resolveApprovedDids, type Entitlement } from '../../auth/entitlements'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

function buildDeps() {
  return {
    tenantsTable: process.env.TENANTS_TABLE!,
    apexDid:
      process.env.APEX_DID ??
      `did:web:${process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social'}`,
    apexHandle: process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social',
    // Use `||` (not `??`) to match auth/pds-session.ts post-T3-review behavior
    // (empty-string env value falls through to ADMIN_EMAIL / default).
    allowedEmails: (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ddb,
  }
}

export async function listAccountsTool(
  email: string,
): Promise<{ accounts: Entitlement[] }> {
  const accounts = await resolveApprovedDids(email, buildDeps())
  return { accounts }
}
