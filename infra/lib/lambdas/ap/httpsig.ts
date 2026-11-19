// draft-cavage HTTP Signatures — the de-facto fediverse (Mastodon) dialect.
// ONLY node:crypto. No npm dependency (Spec #6 SigV4a bundling lesson:
// out-of-band signer deps fail silently when not bundled; node:crypto is
// always present in the Lambda runtime and needs no esbuild bundling).
//
// SIGNING-STRING CONSTRUCTION (byte-exact to Mastodon / draft-cavage,
// derived from the documented rules — NOT guessed):
//
//   The signing string is the named headers (from the Signature header's
//   `headers="..."` list, space-separated, lowercased) joined by "\n":
//     - the special pseudo-header `(request-target)` renders as
//         "(request-target): <method-lowercase> <path>"
//       (path = the request-target / origin-form path, used verbatim;
//        method lowercased). Note the ": " (colon-space) separator —
//        draft-cavage formats `(request-target)` like a normal header line.
//     - every other named header renders as
//         "<lowercased-name>: <value>"
//       with the header value used as-is (no re-canonicalization).
//   Lines joined with a single LF ("\n"), no trailing newline.
//   (draft-cavage-http-signatures §2.3; Mastodon "HTTP Signatures" doc.)
//
//   The `digest` header is integrity-bearing and MUST be independently
//   recomputed as  SHA-256=base64(sha256(rawBody))  and constant-time
//   compared to the request's Digest/digest header BEFORE the RSA verify
//   (a matching signature over an attacker-chosen Digest line is worthless
//   if the body doesn't actually hash to that Digest — so reject early).
//
//   Signature = base64( RSA-SHA256( signingString ) ) over the named keyId's
//   RSA public key (algorithm="rsa-sha256").
//
// verifyRequest is attacker-facing: it NEVER throws — any parse/format/
// crypto failure returns false.

import crypto from 'node:crypto'

interface VerifyReq {
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
}

interface SignArgs {
  method: string
  url: string
  body: Buffer
  keyId: string
  privateKeyPem: string
}

/** Lowercase every header key so lookups are case-insensitive (draft-cavage
 *  treats header names case-insensitively; Node/HTTP frameworks vary case). */
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(headers)) {
    const v = headers[k]
    if (typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

/** Parse a draft-cavage Signature header into its k="v" components.
 *  Split on commas that are NOT inside double quotes (a base64 signature
 *  can itself contain no comma, but keyId/headers are quoted and the
 *  generic safe parse is to respect quotes). */
export function parseSignatureHeader(sig: string): Record<string, string> {
  const params: Record<string, string> = {}
  const parts: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      cur += ch
    } else if (ch === ',' && !inQuotes) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.length) parts.push(cur)
  for (const p of parts) {
    const trimmed = p.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (val.startsWith('"')) {
      // A quoted draft-cavage param MUST be well-formed: a leading quote
      // without a matching trailing quote is a malformed/tampered header
      // (e.g. a corrupted closing `"` on signature="..."). Reject rather
      // than leniently feed a half-quoted blob to base64 — strictness here
      // is what makes a single-char tamper on the header deterministically
      // fail verification (attacker-facing).
      if (!(val.endsWith('"') && val.length >= 2)) {
        throw new Error(`malformed quoted signature param: ${key}`)
      }
      val = val.slice(1, -1)
    }
    if (key) params[key] = val
  }
  return params
}

function sha256DigestHeader(body: Buffer): string {
  return 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64')
}

/** Constant-time string comparison (avoids a timing oracle on the Digest
 *  check; lengths may differ so guard before timingSafeEqual). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Build the draft-cavage signing string from the ordered, space-separated
 *  `headers` list. `(request-target)` is the method-lowercase + path
 *  pseudo-header; every other entry is a real header looked up
 *  case-insensitively. Throws if a named header is absent (caller catches
 *  and returns false). */
function buildSigningString(
  headerList: string[],
  method: string,
  path: string,
  headers: Record<string, string>,
): string {
  const lines: string[] = []
  for (const name of headerList) {
    if (name === '(request-target)') {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`)
    } else {
      const v = headers[name]
      if (v === undefined) {
        throw new Error(`signed header missing: ${name}`)
      }
      lines.push(`${name}: ${v}`)
    }
  }
  return lines.join('\n')
}

export async function verifyRequest(
  req: VerifyReq,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    const headers = lowerHeaders(req.headers)

    const sigHeader = headers['signature']
    if (!sigHeader) return false

    const params = parseSignatureHeader(sigHeader)
    const algorithm = params['algorithm']
    const signatureB64 = params['signature']
    const headerListRaw = params['headers']
    if (!signatureB64) return false
    // Mastodon uses rsa-sha256 exclusively here. If an algorithm is
    // declared, require it; absence defaults to rsa-sha256 (draft-cavage).
    if (algorithm && algorithm.toLowerCase() !== 'rsa-sha256') return false

    // Default header set per draft-cavage when `headers` omitted is "date";
    // Mastodon always sends an explicit list including (request-target).
    const headerList = (headerListRaw && headerListRaw.trim().length
      ? headerListRaw
      : 'date')
      .trim()
      .split(/\s+/)
      .map((h) => h.toLowerCase())

    // Integrity gate: if `digest` is among the signed headers (Mastodon
    // POSTs always sign it), independently recompute it from the raw body
    // and constant-time compare BEFORE the RSA verify. Reject on mismatch.
    if (headerList.includes('digest')) {
      const presentedDigest = headers['digest']
      if (!presentedDigest) return false
      const expectedDigest = sha256DigestHeader(req.body)
      // Mastodon emits "SHA-256=" (uppercase algo, base64). Compare exactly;
      // a benign case variant would still differ here, which is the safe
      // (reject) direction — we never accept a non-matching body.
      if (!constantTimeEqual(presentedDigest, expectedDigest)) return false
    }

    const signingString = buildSigningString(
      headerList,
      req.method,
      req.path,
      headers,
    )

    const signature = Buffer.from(signatureB64, 'base64')
    if (signature.length === 0) return false

    return crypto.verify(
      'rsa-sha256',
      Buffer.from(signingString, 'utf8'),
      { key: publicKeyPem },
      signature,
    )
  } catch {
    return false
  }
}

export async function signRequest(
  args: SignArgs,
): Promise<Record<string, string>> {
  const { method, url, body, keyId, privateKeyPem } = args
  const u = new URL(url)
  const host = u.host
  // request-target path = origin-form (path + optional query), used verbatim.
  const path = u.pathname + (u.search || '')

  const digest = sha256DigestHeader(body)
  const date = new Date().toUTCString() // RFC-1123 GMT, e.g. "Mon, 18 May 2026 14:30:00 GMT"

  const headerList = ['(request-target)', 'host', 'date', 'digest']
  const signingHeaders: Record<string, string> = {
    host,
    date,
    digest,
  }
  const signingString = buildSigningString(
    headerList,
    method,
    path,
    signingHeaders,
  )

  const b64 = crypto
    .sign('rsa-sha256', Buffer.from(signingString, 'utf8'), {
      key: privateKeyPem,
    })
    .toString('base64')

  const signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${b64}"`

  return {
    Host: host,
    Date: date,
    Digest: digest,
    'Content-Type': 'application/activity+json',
    Signature: signature,
  }
}

// ---------------------------------------------------------------------------
// Inbox signature POLICY (separate from verifyRequest on purpose).
//
// verifyRequest proves "this signature covers the headers it names". It must
// stay permissive about WHICH headers are named, because GET-with-no-body
// signatures (authorized fetch) legitimately sign only (request-target) host
// date. The INBOX is a stricter, POST-only surface: an attacker who can pick
// the signed-header list could omit `digest` (so the body is not bound) or
// `date` (so the request is replayable forever). The inbox therefore applies
// this policy BEFORE verifyRequest.
//
// Real Mastodon signs `(request-target) host date digest` and, on newer
// versions, additionally `content-type`. Extra signed headers are allowed;
// the REQUIRED set is the intersection every conformant sender includes.
// ---------------------------------------------------------------------------

/** Max accepted |now - Date| for a signed inbox request (replay window). */
export const INBOX_MAX_SKEW_MS = 5 * 60 * 1000

export type SignaturePolicyFailure =
  | 'malformed_signature'
  | 'missing_signed_header'
  | 'missing_date'
  | 'invalid_date'
  | 'date_skew'

/**
 * Returns null when the request satisfies the inbox policy, else the reason.
 * `digest` is required only when the request carries a body. Pure; never throws.
 */
export function checkInboxSignaturePolicy(args: {
  signatureHeader: string
  dateHeader: string | undefined
  hasBody: boolean
  now?: number
}): SignaturePolicyFailure | null {
  let params: Record<string, string>
  try {
    params = parseSignatureHeader(args.signatureHeader)
  } catch {
    return 'malformed_signature'
  }
  const listed = (params['headers'] ?? '').trim()
  // Absent `headers` defaults to just "date" per draft-cavage: that omits
  // (request-target) and host, so it can never satisfy the inbox.
  const signed = new Set(
    (listed.length ? listed : 'date').split(/\s+/).map((h) => h.toLowerCase()),
  )
  const required = ['(request-target)', 'host', 'date']
  if (args.hasBody) required.push('digest')
  for (const h of required) {
    if (!signed.has(h)) return 'missing_signed_header'
  }
  if (!args.dateHeader) return 'missing_date'
  const t = Date.parse(args.dateHeader)
  if (!Number.isFinite(t)) return 'invalid_date'
  const now = args.now ?? Date.now()
  if (Math.abs(now - t) > INBOX_MAX_SKEW_MS) return 'date_skew'
  return null
}
