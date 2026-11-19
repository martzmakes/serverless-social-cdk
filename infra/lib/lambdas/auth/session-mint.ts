import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { makeSessionFor } from '../pds/session'
import { apexTenant, type Tenant } from '../pds/tenant'
import { resolveApprovedDids, type ResolveDeps } from './entitlements'

export async function mintFirstPartySession(
  email: string,
  tenantByEmail: (e: string) => Promise<{ did: string; handle: string; signingKeyRef?: string; status: string } | null>,
  secret: Uint8Array,
) {
  const row = await tenantByEmail(email)
  if (!row || row.status !== 'active') return null
  const t: Tenant = { did: row.did, handle: row.handle, method: 'plc', signingKeyRef: row.signingKeyRef ?? '', pdsEndpoint: `https://${process.env.DOMAIN ?? 'serverless.social'}` }
  const s = await makeSessionFor(t, secret) // plain HS256 Bearer, no cnf — first-party path
  return { did: t.did, handle: t.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt }
}

// ── Spec #6 T2: entitlement-gated per-DID minter ─────────────────────────────
//
// Resolves the caller's approved DIDs via `resolveApprovedDids`, requires the
// requested `targetDid` to match one EXACTLY (no fuzzy/handle fallback). Then
// branches:
//   - apex DID  → mint with the deployment identity used by the entitlement check.
//   - tenant DID → re-query TenantsTable by `did` PK to recover the full row,
//     including `signingKeyRef` (the `Tenant` shape requires it per Spec #2's
//     keypair-per-tenant invariant), then mint.
//
// Returns `null` when:
//   - entitlements are empty (unapproved email), OR
//   - `targetDid` isn't in the caller's entitlement list.
// The caller maps `null` → MCP `not_entitled` error.

export type MintForDeps = ResolveDeps & {
  secret: Uint8Array
}

export async function mintFirstPartySessionFor(
  email: string,
  targetDid: string,
  deps: MintForDeps,
): Promise<{ did: string; handle: string; accessJwt: string; refreshJwt: string } | null> {
  const ents = await resolveApprovedDids(email, deps)
  const match = ents.find((e) => e.did === targetDid)
  if (!match) return null

  let t: Tenant
  if (match.did === deps.apexDid) {
    t = {
      ...apexTenant(),
      did: deps.apexDid,
      handle: deps.apexHandle,
      pdsEndpoint: `https://${deps.apexHandle}`,
    }
  } else {
    // Re-query TenantsTable by DID PK to recover `signingKeyRef` (and re-confirm
    // the row is still live). Belt-and-suspenders vs. the entitlement listing,
    // which already filters status='active' via the byEmail GSI.
    const res = await deps.ddb.send(
      new GetCommand({ TableName: deps.tenantsTable, Key: { did: match.did } }),
    )
    const row = res.Item as
      | { did: string; handle: string; signingKeyRef?: string; status?: string }
      | undefined
    // Belt-and-suspenders: deactivated between resolver and re-query, OR row missing the signing-key ref (partially-provisioned) → deny.
    if (!row || row.status !== 'active' || !row.signingKeyRef) return null
    t = {
      did: row.did,
      handle: row.handle,
      method: 'plc',
      signingKeyRef: row.signingKeyRef,
      pdsEndpoint: `https://${process.env.DOMAIN ?? 'serverless.social'}`,
    }
  }

  const s = await makeSessionFor(t, deps.secret)
  return { did: t.did, handle: t.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt }
}
