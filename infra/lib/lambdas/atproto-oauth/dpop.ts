import { jwtVerify, importJWK, calculateJwkThumbprint, decodeProtectedHeader } from 'jose'

export interface DpopCheck {
  htm: string
  htu: string
  seenJti: (jti: string) => Promise<boolean> // returns true if already used (replay)
  expectAth?: string                          // base64url SHA-256 of access token, when binding
  maxSkewSec?: number
}

export async function verifyDpopProof(proofJwt: string, c: DpopCheck): Promise<{ jkt: string }> {
  const hdr = decodeProtectedHeader(proofJwt)
  if (hdr.typ !== 'dpop+jwt') throw new Error('dpop: bad typ')
  if (hdr.alg !== 'ES256') throw new Error('dpop: bad alg')
  if (!hdr.jwk || 'd' in (hdr.jwk as any)) throw new Error('dpop: missing/private jwk')
  const key = await importJWK(hdr.jwk as any, 'ES256')
  const { payload } = await jwtVerify(proofJwt, key, { typ: 'dpop+jwt' })
  if (payload.htm !== c.htm) throw new Error('dpop: htm mismatch')
  if (payload.htu !== c.htu) throw new Error('dpop: htu mismatch')
  if (typeof payload.jti !== 'string' || !payload.jti) throw new Error('dpop: missing jti')
  const skew = c.maxSkewSec ?? 300
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > skew) throw new Error('dpop: iat skew')
  if (c.expectAth && payload.ath !== c.expectAth) throw new Error('dpop: ath mismatch')
  if (await c.seenJti(payload.jti)) throw new Error('dpop: jti replay')
  return { jkt: await calculateJwkThumbprint(hdr.jwk as any) }
}

export async function jwkThumbprint(jwk: object): Promise<string> {
  return calculateJwkThumbprint(jwk as any)
}
