/**
 * delete-record.ts — `delete_record` MCP tool (Spec #6 T8).
 *
 * Flow (mirrors create-post.ts / create-longform.ts, with one NEW gate):
 *   1. Validate input shape (account + uri non-empty strings). Otherwise →
 *      McpToolError('invalid_account').
 *   2. Parse `uri` with /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/. No match →
 *      McpToolError('uri_mismatch', { reason: 'malformed uri' }). Captures
 *      {did, collection, rkey}.
 *   3. Resolve caller's entitlements (resolveApprovedDids); match `account`
 *      arg against DID or handle. No match → McpToolError('not_entitled').
 *   4. **Cross-DID gate**: if the resolved entitlement's DID !== the URI's
 *      embedded DID, REJECT with McpToolError('uri_mismatch', {account_did,
 *      uri_did}). NO PDS call. Defends against an admin (apex tenant) calling
 *      delete_record with `account='serverless.social'` + `uri='at://did:plc:
 *      a62…/x'` — the apex JWT would otherwise have no scope on that repo,
 *      but we still close the loop here so the LLM gets a clear typed error
 *      rather than a generic PDS 4xx.
 *   5. Mint per-DID PDS session via mintFirstPartySessionFor. null →
 *      McpToolError('not_entitled') (race: tenant deactivated between resolve
 *      and re-query).
 *   6. POST com.atproto.repo.deleteRecord with {repo, collection, rkey}.
 *   7. Map PdsHttpError: 404 → 'not_found' (record already gone or never
 *      existed — distinct code so the LLM can suppress the noise), other
 *      statuses → 'pds_error'.
 *   8. Return { deleted: true }.
 *
 * URI parsing notes (cross-DID gate hardness):
 *   - Regex uses [^/] for each segment, so trailing slashes / extra path
 *     components fall out as "malformed uri" (no PDS call).
 *   - DIDs are case-sensitive per the AT-Proto spec; we do NOT lowercase
 *     either side of the compare. Mixed-case DIDs are simply not-equal to
 *     the canonical lowercase one stored in entitlements → uri_mismatch.
 *   - The regex anchors to `$`, so query strings / fragments after the rkey
 *     are rejected as malformed.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

import { resolveApprovedDids } from '../../auth/entitlements'
import { mintFirstPartySessionFor } from '../../auth/session-mint'
import { McpToolError } from './lib/mcp-tool-error'
import { pdsFetch, PdsHttpError } from './lib/pds-fetch'

export { PdsHttpError }
export { McpToolError } from './lib/mcp-tool-error'

// ── Module-level clients (cold-start once, reused across invocations) ────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const ssm = new SSMClient({})

// ── Cached JWT signing secret (loaded once per Lambda lifetime) ──────────────
let cachedSecret: Uint8Array | null = null
async function getSecret(): Promise<Uint8Array> {
  if (cachedSecret) return cachedSecret
  const res = await ssm.send(
    new GetParameterCommand({
      Name: process.env.JWT_SECRET_PARAM!,
      WithDecryption: true,
    }),
  )
  if (!res.Parameter?.Value) throw new Error('JWT secret missing')
  cachedSecret = new TextEncoder().encode(res.Parameter.Value)
  return cachedSecret
}

// ── Test hook: parallel to create-post.ts / create-longform.ts pattern ──────
export const __testOnly__ = {
  /** Tests inject a stub fetch; production leaves undefined → globalThis.fetch. */
  fetchImpl: undefined as typeof fetch | undefined,
}

// ── Public surface ───────────────────────────────────────────────────────────
export type DeleteRecordInput = {
  /** DID or handle from list_accounts. */
  account: string
  /** at://<did>/<collection>/<rkey> — DID MUST match the resolved account. */
  uri: string
}

// ── Deps builder (env reads; mirrors create-post.ts / create-longform.ts) ───
function buildDepsBase() {
  return {
    tenantsTable: process.env.TENANTS_TABLE!,
    apexDid:
      process.env.APEX_DID ??
      `did:web:${process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social'}`,
    apexHandle: process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? 'serverless.social',
    // `||` not `??` — matches auth/pds-session.ts post-T3-review behavior.
    allowedEmails: (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ddb,
  }
}

// at://<did>/<collection>/<rkey> — exactly 3 segments, no trailing slash,
// no query/fragment. Segments are [^/]+ so internal slashes are rejected.
const AT_URI_RE = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/

export async function deleteRecordTool(
  email: string,
  input: DeleteRecordInput,
): Promise<{ deleted: true }> {
  // 1. Input shape validation
  if (
    !input ||
    typeof input.account !== 'string' ||
    input.account.length === 0 ||
    typeof input.uri !== 'string' ||
    input.uri.length === 0
  ) {
    throw new McpToolError('invalid_account')
  }

  // 2. Parse AT-URI. Anchored regex rejects trailing slashes, query strings,
  // fragments, and any extra path components.
  const m = AT_URI_RE.exec(input.uri)
  if (!m) {
    throw new McpToolError('uri_mismatch', { reason: 'malformed uri' })
  }
  const parsed = { did: m[1], collection: m[2], rkey: m[3] }

  // 3. Build deps + resolve entitlements
  const depsBase = buildDepsBase()
  const ents = await resolveApprovedDids(email, depsBase)
  const match = ents.find((e: { did: string; handle: string }) =>
    e.did === input.account || e.handle === input.account,
  )
  if (!match) throw new McpToolError('not_entitled')

  // 4. Cross-DID gate — strict equality, case-sensitive. Closes the attack
  // where an admin's apex JWT is used to attempt a delete on a tenant repo.
  if (match.did !== parsed.did) {
    throw new McpToolError('uri_mismatch', {
      account_did: match.did,
      uri_did: parsed.did,
    })
  }

  // 5. Mint per-DID PDS session
  const secret = await getSecret()
  const session = await mintFirstPartySessionFor(email, match.did, {
    ...depsBase,
    secret,
  })
  if (!session) throw new McpToolError('not_entitled')

  // 6. deleteRecord
  const fetchImpl = __testOnly__.fetchImpl
  try {
    await pdsFetch(
      'POST',
      '/xrpc/com.atproto.repo.deleteRecord',
      session.accessJwt,
      {
        repo: parsed.did,
        collection: parsed.collection,
        rkey: parsed.rkey,
      },
      { fetchImpl },
    )
  } catch (e) {
    if (e instanceof PdsHttpError) {
      // 404 = record never existed or already deleted → distinct code so the
      // LLM can suppress the noise rather than escalating to generic pds_error.
      if (e.status === 404) {
        throw new McpToolError('not_found', { status: e.status, body: e.body })
      }
      throw new McpToolError('pds_error', { status: e.status, body: e.body })
    }
    throw e
  }

  return { deleted: true }
}
