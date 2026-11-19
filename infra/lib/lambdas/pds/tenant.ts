import { APEX_DID } from './tenant-keys'
import { HANDLE, PDS_ENDPOINT, SIGNING_KEY_SSM } from './lexicons'

export interface Tenant {
  did: string
  handle: string
  method: 'web' | 'plc'
  signingKeyRef: string
  pdsEndpoint: string
}
export interface TenantStore {
  byDid(did: string): Promise<any | null>
  byHandle(handle: string): Promise<any | null>
  listActive(): Promise<Array<{ did: string }>>
}

export function apexTenant(): Tenant {
  return { did: APEX_DID, handle: HANDLE, method: 'web', signingKeyRef: SIGNING_KEY_SSM, pdsEndpoint: PDS_ENDPOINT }
}

const fromRow = (r: any): Tenant => ({
  did: r.did, handle: r.handle, method: 'plc', signingKeyRef: r.signingKeyRef, pdsEndpoint: PDS_ENDPOINT,
})

/** Resolve by did OR handle. Apex matched FIRST, no store read. Non-active → null. */
export async function resolveTenant(
  input: { did?: string; handle?: string },
  store: TenantStore,
): Promise<Tenant | null> {
  if (input.did === APEX_DID || input.handle === HANDLE) return apexTenant()
  const row = input.did ? await store.byDid(input.did)
    : input.handle ? await store.byHandle(input.handle) : null
  if (!row || row.status !== 'active') return null
  return fromRow(row)
}

/**
 * Resolve the Tenant that "owns" a request Host — used by host-scoped
 * discovery endpoints (`/.well-known/atproto-did`, `describeServer`'s
 * `availableUserDomains`) where the caller isn't identified by a
 * handle/DID param but by which domain is being asked.
 *
 * A tenant's `handle` IS its serving domain (e.g. `martzmakes.com`), so this
 * is `resolveTenant({ handle: host })` under the hood — the same store read
 * `com.atproto.identity.resolveHandle` already does for an explicit
 * `?handle=` query param. The only difference is the fallback: this NEVER
 * returns null. A missing, malformed, or unrecognized host (including the
 * apex domain itself) resolves to `apexTenant()`, matching the existing
 * apex-default behavior of every other unauthenticated read path in this
 * file (`resolveReadTenant` in handler.ts falls back to `APEX_DID`).
 *
 * `host` may include a port (`localhost:4000`) or mixed case; both are
 * normalized before lookup.
 */
export async function resolveTenantByHost(
  host: string | undefined,
  store: TenantStore,
): Promise<Tenant> {
  const normalized = (host ?? '').split(':')[0].trim().toLowerCase()
  if (!normalized || normalized === HANDLE) return apexTenant()
  const tenant = await resolveTenant({ handle: normalized }, store)
  return tenant ?? apexTenant()
}
