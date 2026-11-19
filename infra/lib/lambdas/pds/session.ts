import { createHash, timingSafeEqual } from 'node:crypto'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { SignJWT, jwtVerify } from 'jose'
import { DID, HANDLE } from './lexicons'
import { type Tenant, apexTenant } from './tenant'

// ---------------------------------------------------------------------------
// Internal signing helper
// ---------------------------------------------------------------------------

async function sign(did: string, secret: Uint8Array, scope: string, ttl: string) {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(did)
    .setAudience(did)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret)
}

// ---------------------------------------------------------------------------
// Tenant-parameterized variants
// ---------------------------------------------------------------------------

export async function makeSessionFor(t: Tenant, secret: Uint8Array) {
  return {
    did: t.did,
    handle: t.handle,
    accessJwt: await sign(t.did, secret, 'com.atproto.access', '2h'),
    refreshJwt: await sign(t.did, secret, 'com.atproto.refresh', '90d'),
  }
}

export async function verifyAccessFor(t: Tenant, jwt: string, secret: Uint8Array) {
  const { payload } = await jwtVerify(jwt, secret, { audience: t.did })
  if (payload.scope !== 'com.atproto.access') throw new Error('bad scope')
  return payload as unknown as { sub: string; scope: string }
}

export async function verifyRefreshFor(t: Tenant, jwt: string, secret: Uint8Array) {
  const { payload } = await jwtVerify(jwt, secret, { audience: t.did })
  if (payload.scope !== 'com.atproto.refresh') throw new Error('bad scope')
  return payload
}

// ---------------------------------------------------------------------------
// OAuth: DPoP-bound access token
// ---------------------------------------------------------------------------

export async function makeAccessFor(t: Tenant, secret: Uint8Array, jkt?: string): Promise<string> {
  const b = new SignJWT(jkt ? { scope: 'com.atproto.access', cnf: { jkt } } : { scope: 'com.atproto.access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(t.did).setAudience(t.did).setIssuedAt().setExpirationTime('2h')
  return b.sign(secret)
}

// ---------------------------------------------------------------------------
// Apex-preserving wrappers (byte-identical behavior to original exports)
// ---------------------------------------------------------------------------

export async function makeSession(secret: Uint8Array) {
  return makeSessionFor(apexTenant(), secret)
}

export async function verifyAccess(jwt: string, secret: Uint8Array) {
  return verifyAccessFor(apexTenant(), jwt, secret)
}

export async function verifyRefresh(jwt: string, secret: Uint8Array) {
  return verifyRefreshFor(apexTenant(), jwt, secret)
}

// ---------------------------------------------------------------------------
// App-password check for com.atproto.server.createSession
// ---------------------------------------------------------------------------

const appPasswordSsm = new SSMClient({})
// Per-container cache of the SecureString value, keyed by parameter name.
// Only successful, non-empty reads are cached (failures re-try next call).
const appPasswordCache = new Map<string, string>()

async function readAppPassword(paramName: string): Promise<string | null> {
  const hit = appPasswordCache.get(paramName)
  if (hit) return hit
  try {
    const res = await appPasswordSsm.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    )
    const value = res.Parameter?.Value
    if (!value) return null
    appPasswordCache.set(paramName, value)
    return value
  } catch {
    return null
  }
}

/**
 * True only when `presented` equals the app password stored in SSM
 * SecureString `paramName`. Fails closed: unset param name, missing/empty
 * parameter, SSM error, or non-string input all return false. Compares SHA-256
 * digests with timingSafeEqual (constant time, length-independent).
 */
export async function verifyAppPassword(
  presented: string,
  paramName: string | undefined,
): Promise<boolean> {
  if (!paramName || typeof presented !== 'string' || presented.length === 0) return false
  const expected = await readAppPassword(paramName)
  if (!expected) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
