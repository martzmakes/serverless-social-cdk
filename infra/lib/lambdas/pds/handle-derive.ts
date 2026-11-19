/**
 * handle-derive.ts — Pure email → safe DNS label handle derivation.
 *
 * Produces a `<label>.serverless.social` handle from an email address that is:
 *   - A legal DNS label: lowercase, [a-z0-9-], no leading/trailing dash, ≤30 chars
 *   - Not in the DENY set (sensitive names + RESERVED_PREFIXES from longform-routing)
 *   - Not already taken (checked via the injected `isTaken` port)
 *
 * If the derived label collides with a denied or taken handle, numeric suffixes
 * are tried (label2, label3, …) until a free slot is found.
 *
 * PURE: no I/O except the injected `isTaken` callback. Only imports: node:crypto.
 */

import { createHash } from 'node:crypto'
import { RESERVED_PREFIXES } from './longform-routing.js'

const DOMAIN = 'serverless.social'
const MAX_LABEL_LEN = 30

/**
 * Additional sensitive DNS labels that must never be assigned to users,
 * regardless of whether they appear in RESERVED_PREFIXES.
 *
 * NOTE: 'well-known' (no dot) is included explicitly here because
 * sanitizeLocalPart converts dots→'-' and trims, so the raw email
 * local-part '.well-known' sanitizes to 'well-known' — the dotted
 * form in RESERVED_PREFIXES would never match.
 */
const DENY_EXTRA = new Set<string>([
  'www', 'api', 'admin', 'mail', 'ns', 'smtp', 'imap',
  '_atproto', 'atproto', 'app', 'cdn', 'assets', 'static',
  'root', 'support', 'help', 'about', 'status', 'health',
  'well-known',
])

/**
 * Full deny set: DENY_EXTRA ∪ RESERVED_PREFIXES (Phase C lockstep).
 * Exported so callers (Task 3 etc.) can reuse without re-computing.
 */
export const DENY: ReadonlySet<string> = new Set<string>([
  ...DENY_EXTRA,
  ...RESERVED_PREFIXES,
])

/**
 * Returns true if `label` is in the combined deny/reserved set.
 * Exported as a testable helper.
 */
export function isReservedLabel(label: string): boolean {
  return DENY.has(label)
}

/**
 * Sanitize an email local-part into a legal DNS label.
 *
 * Steps:
 *   1. lowercase
 *   2. replace any run of characters that are NOT [a-z0-9] with a single '-'
 *   3. trim leading/trailing '-'
 *   4. cap to MAX_LABEL_LEN chars, then re-trim trailing '-'
 *
 * Returns an empty string if the result would be empty (caller must handle).
 */
function sanitizeLocalPart(local: string): string {
  let s = local.toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, '-')
  s = s.replace(/^-+|-+$/g, '')
  s = s.slice(0, MAX_LABEL_LEN)
  s = s.replace(/-+$/, '')
  return s
}

/**
 * A short, deterministic hash of the full email — used as the fallback label
 * when the local-part sanitizes to empty (e.g. `!!!@x.com`).
 * Same email always produces the same hash (pure).
 */
function shortHash(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 8)
}

/**
 * Derive a `<label>.serverless.social` handle from `email`.
 *
 * @param email   The user's email address.
 * @param isTaken Port: resolves true if `<label>.serverless.social` is already
 *                registered in TenantsTable (called with the FULL handle string).
 * @returns       A full handle like `alice.serverless.social`.
 */
export async function deriveHandle(
  email: string,
  isTaken: (handle: string) => Promise<boolean>,
): Promise<string> {
  // Strip Gmail-style plus-addressing tag (e.g. alice+tag → alice) before sanitising.
  // This gives cleaner handles and matches the expected spec behaviour.
  // Note: String.prototype.split always returns a non-empty array, so [0] is never undefined.
  const rawLocal = email.split('@')[0]
  const local = rawLocal.split('+')[0]
  let base = sanitizeLocalPart(local)

  // Fallback when the sanitized label is empty
  if (base === '') {
    base = `user${shortHash(email)}`
  }

  // Find the first candidate that is neither denied nor taken.
  // Try: base, base2, base3, …
  //
  // For suffixed candidates, the base is truncated to MAX_LABEL_LEN - len(suffix)
  // so every emitted label (including suffixed ones) satisfies the ≤30-char DNS
  // label invariant. Any trailing '-' introduced by the truncation is stripped so
  // the label remains a legal DNS label (no leading/trailing hyphen).
  // Terminal bound: the numeric-suffix space is effectively unbounded, but a
  // truly-exhausted label space (every candidate denied/taken) must fail loud
  // rather than loop forever or return a colliding/unsafe handle. 10_000 attempts
  // is unreachable in practice — behavior below the cap is identical to before.
  const MAX_SUFFIX_ATTEMPTS = 10_000
  let label = base
  let suffix = 2
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt++) {
    const candidate = `${label}.${DOMAIN}`
    if (!isReservedLabel(label) && !(await isTaken(candidate))) {
      return candidate
    }
    const suffixStr = String(suffix)
    const truncatedBase = base
      .slice(0, MAX_LABEL_LEN - suffixStr.length)
      .replace(/-+$/, '')
    label = `${truncatedBase}${suffixStr}`
    suffix++
  }
  throw new Error(
    `deriveHandle: exhausted ${MAX_SUFFIX_ATTEMPTS} suffix attempts for "${base}" — no free handle slot found`,
  )
}
