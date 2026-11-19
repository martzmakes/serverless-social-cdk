/**
 * appview-proxy.ts — service-auth pipethrough for app.bsky.* reads.
 *
 * Implements the AT Protocol service-auth (inter-service JWT) pattern so this
 * PDS can forward app.bsky.* queries to the first-party AppView at
 * https://api.bsky.app with a signed JWT credential.
 *
 * JWT construction mirrors @atproto/xrpc-server's createServiceJwt exactly:
 *   header  { typ:'JWT', alg: keypair.jwtAlg }
 *   payload { iat, iss: DID, aud, exp: iat+60, lxm, jti }
 *   sig     = keypair.sign(Buffer.from(`${b64url(header)}.${b64url(payload)}`))
 *   token   = `${b64url(header)}.${b64url(payload)}.${base64url(sig)}`
 *
 * xrpc-server is NOT installed in this Lambda bundle; we replicate the same
 * algorithm using @atproto/crypto (which IS installed) and Node's built-in
 * crypto (for the random jti). The wire format is bit-for-bit compatible.
 */

import { Secp256k1Keypair } from '@atproto/crypto'
import { DID } from './lexicons.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_APPVIEW = 'did:web:api.bsky.app'
const DEFAULT_APPVIEW_HTTP = 'https://api.bsky.app'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonToB64Url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

async function randomHex(bytes: number): Promise<string> {
  // Node 22 has globalThis.crypto (Web Crypto)
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return Buffer.from(buf).toString('hex')
}

// ---------------------------------------------------------------------------
// serviceAuthJwt
// ---------------------------------------------------------------------------

/**
 * Mint a signed AT Protocol inter-service JWT.
 *
 * Header: { typ: 'JWT', alg: 'ES256K' }
 * Payload: { iat, iss, aud, exp, lxm?, jti }
 * Signature: secp256k1 low-S over ASCII bytes of `header.payload`
 *
 * @param keypair  Secp256k1Keypair (repo signing key for `iss`)
 * @param lxm      Lexicon method being called (e.g. 'app.bsky.actor.getProfile').
 *                 Pass an empty string to omit the claim entirely.
 * @param aud      Audience DID (default: 'did:web:api.bsky.app')
 * @param iss      Issuer DID (default: the apex DID constant). Pass an explicit
 *                 DID when minting on behalf of a sub-tenant.
 * @param expSeconds  TTL in seconds (default: 60). Spec caps at 1 hour.
 */
export async function serviceAuthJwt(
  keypair: Secp256k1Keypair,
  lxm: string,
  aud: string = DEFAULT_APPVIEW,
  iss: string = DID,
  expSeconds = 60,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1_000)
  const exp = iat + expSeconds
  const jti = await randomHex(16)

  const header = { typ: 'JWT', alg: keypair.jwtAlg }
  // Omit `lxm` from the payload when empty so the JWT isn't bound to any
  // particular lexicon method (matches atproto OAuth-spec optional-field
  // semantics — `lxm` is optional in com.atproto.server.getServiceAuth).
  const payload: Record<string, unknown> = lxm
    ? { iat, iss, aud, exp, lxm, jti }
    : { iat, iss, aud, exp, jti }

  const toSignStr = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`
  const toSign = Buffer.from(toSignStr, 'utf8')

  const sigBytes = await keypair.sign(toSign)
  const sig = Buffer.from(sigBytes).toString('base64url')

  return `${toSignStr}.${sig}`
}

// ---------------------------------------------------------------------------
// proxyAppView
// ---------------------------------------------------------------------------

export type ProxyResult = {
  status: number
  body: string
  contentType: string
}

/**
 * Forward a GET query to the AppView and return the buffered response.
 *
 * @param method   XRPC NSID (e.g. 'app.bsky.actor.getProfile')
 * @param query    Query-string parameters to forward
 * @param keypair  Repo signing key (used to mint the service-auth JWT)
 * @param opts     Optional overrides (appviewHttp for testing; iss = the DID
 *                 the request is made as — the signed-in viewer, whose key
 *                 `keypair` must be. Defaults to the apex DID.)
 */
export async function proxyAppView(
  method: string,
  query: Record<string, string | undefined>,
  keypair: Secp256k1Keypair,
  opts?: { appviewHttp?: string; iss?: string },
): Promise<ProxyResult> {
  const base = opts?.appviewHttp ?? DEFAULT_APPVIEW_HTTP

  // Build query string (skip undefined values)
  const qs = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const url = `${base}/xrpc/${method}${qs ? `?${qs}` : ''}`

  const jwt = await serviceAuthJwt(keypair, method, DEFAULT_APPVIEW, opts?.iss ?? DID)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    // Network / DNS failure
    return {
      status: 502,
      body: JSON.stringify({ error: 'UpstreamFailure' }),
      contentType: 'application/json',
    }
  }

  const body = await response.text()
  const contentType =
    response.headers.get('content-type') ?? 'application/json'

  return {
    status: response.status,
    body,
    contentType,
  }
}
