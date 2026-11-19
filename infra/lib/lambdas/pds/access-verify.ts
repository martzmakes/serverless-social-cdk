import { decodeJwt } from 'jose'
import { resolveTenant, type TenantStore } from './tenant.js'
import { verifyAccessFor } from './session.js'
import { verifyDpopProof } from '../atproto-oauth/dpop.js'

export interface XrpcIdentity { did: string }

export async function verifyXrpcAuth(
  authHeader: string | undefined,
  dpopHeader: string | undefined,
  htm: string,
  htu: string,
  store: TenantStore,
  secret: Uint8Array,
  seenJti: (j: string) => Promise<boolean> = async () => false,
): Promise<XrpcIdentity | null> {
  if (!authHeader) return null
  const m = /^(Bearer|DPoP)\s+(.+)$/i.exec(authHeader)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const token = m[2]
  try {
    const sub = (decodeJwt(token) as any).sub as string
    if (!sub) return null
    const tenant = await resolveTenant({ did: sub }, store) // apex short-circuits, no DDB
    if (!tenant) return null
    const claims: any = await verifyAccessFor(tenant, token, secret)
    const jkt = claims.cnf?.jkt as string | undefined
    if (jkt) {
      // DPoP-bound token: a matching proof is mandatory
      if (scheme !== 'dpop' || !dpopHeader) return null
      const r = await verifyDpopProof(dpopHeader, { htm, htu, seenJti })
      if (r.jkt !== jkt) return null
    }
    return { did: tenant.did }
  } catch {
    return null
  }
}
