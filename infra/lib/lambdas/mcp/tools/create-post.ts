/**
 * create-post.ts — `create_post` MCP tool (Spec #6 T6).
 *
 * Flow:
 *   1. Validate input shape (account non-empty string, text string).
 *   2. Resolve caller's entitlements (resolveApprovedDids); match `account` arg
 *      against DID or handle. No match → McpToolError('not_entitled').
 *   3. Mint per-DID PDS session via mintFirstPartySessionFor. null →
 *      McpToolError('not_entitled') (race: tenant deactivated between resolve
 *      and re-query).
 *   4. Optionally uploadBlob for each embed image (base64 → bytes, reject if
 *      >7.5MB raw). Collect the returned `blob` object (carries IPLD `$link`).
 *   5. POST createRecord with the assembled `app.bsky.feed.post` record.
 *
 * Blast-radius gate: the LLM picks `account` intentionally; this tool will
 * NEVER write to a DID outside the caller's entitlement list. Per-DID JWT
 * scoping (via mintFirstPartySessionFor) is the second wall.
 *
 * McpToolError declares the FULL union of codes used across Spec #6 T6–T8
 * (`slug_conflict`, `uri_mismatch`, `not_found` are reserved for T7/T8) so
 * later tools can re-use this class without re-extending.
 *
 * Idempotency (dup-post hardening, docs/audit-2026-09-01):
 *   `com.atproto.repo.createRecord` always mints a fresh TID rkey — there is
 *   NO server-side dedup, so any caller-side retry (e.g. the MCP client
 *   resending a `tools/call` after an API Gateway ~29s timeout, or a Lambda
 *   cold-start race) creates a brand-new, fully-duplicate post. This module
 *   keeps a short-lived, per-container in-flight + recent-result cache keyed
 *   by (did, text, reply_to, embed) so a retry of the SAME logical call
 *   within IDEMPOTENCY_TTL_MS returns the ORIGINAL {uri, cid} instead of
 *   writing again.
 *
 *   Known limitation: this cache is process-local (a Map in Lambda module
 *   scope). It does NOT protect across a cold start or two concurrent warm
 *   containers — only a durable, server-side idempotency key (or a
 *   check-before-write against the PDS) closes that gap fully. It DOES
 *   protect the common case (client retries hitting the same warm
 *   container, or two near-simultaneous calls in one container racing on
 *   the same in-flight promise).
 *
 *   This is a defense-in-depth guard for the MCP write path specifically —
 *   it does NOT address the root cause of the observed 2026-05-22 6x
 *   duplicate apex post (that was DynamoDB-Stream retries in
 *   infra/lib/lambdas/pds/longform-renderer.ts re-running an already-
 *   succeeded `syndicate()` call; see docs/audit-2026-09-01 notes).
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

// ── Test hook: tests inject a stub fetch; production leaves undefined →
// ── globalThis.fetch (pdsFetch's default). Consistent with #5d/#5e
// ── "__testOnly__" extraction pattern.
export const __testOnly__ = {
  /** Tests inject a stub fetch; production leaves undefined → globalThis.fetch. */
  fetchImpl: undefined as typeof fetch | undefined,
  /** Tests call this in beforeEach to avoid cross-test cache bleed (module-level Maps persist for the file's lifetime). */
  resetIdempotencyCache(): void {
    inflightByKey.clear()
    recentResultByKey.clear()
  },
}

// ── Idempotency cache (see module doc comment above) ──────────────────────────
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000 // 5 minutes — comfortably longer than any client retry delay
const inflightByKey = new Map<string, Promise<{ uri: string; cid: string }>>()
const recentResultByKey = new Map<string, { result: { uri: string; cid: string }; expiresAt: number }>()

function pruneExpired(now: number): void {
  for (const [k, v] of recentResultByKey) {
    if (v.expiresAt <= now) recentResultByKey.delete(k)
  }
}

/** Fingerprint of everything that determines the resulting record — excludes `account` (caller passes did/handle interchangeably; keyed on the RESOLVED did instead). */
function idempotencyKey(did: string, input: CreatePostInput): string {
  return JSON.stringify({
    did,
    text: input.text,
    reply_to: input.reply_to ?? null,
    embed: input.embed ?? null,
  })
}

// ── Public surface ───────────────────────────────────────────────────────────
export type CreatePostInput = {
  /** DID or handle from list_accounts. */
  account: string
  text: string
  reply_to?: {
    root_uri: string
    root_cid: string
    parent_uri: string
    parent_cid: string
  }
  embed?: {
    images?: Array<{ bytes_b64: string; mime: string; alt: string }>
  }
}

// ── Deps builder (env reads; mirrors list-accounts.ts:18-33) ─────────────────
function buildDepsBase() {
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

// API GW base64-inflates ~33% → ~7.5 MB raw keeps us under the 10 MB request cap.
const MAX_IMAGE_BYTES = 7_500_000

export async function createPostTool(
  email: string,
  input: CreatePostInput,
): Promise<{ uri: string; cid: string }> {
  // 1. Input shape validation
  if (
    !input ||
    typeof input.account !== 'string' ||
    input.account.length === 0 ||
    typeof input.text !== 'string'
  ) {
    throw new McpToolError('invalid_account')
  }

  // 2. Build deps + resolve entitlements
  const depsBase = buildDepsBase()
  const ents = await resolveApprovedDids(email, depsBase)
  const match = ents.find((e) => e.did === input.account || e.handle === input.account)
  if (!match) throw new McpToolError('not_entitled')

  // 2b. Idempotency check — see module doc comment. A retry of the SAME
  // logical call (same did/text/reply_to/embed) within the TTL returns the
  // original result instead of writing a duplicate record.
  const key = idempotencyKey(match.did, input)
  const now = Date.now()
  pruneExpired(now)
  const cached = recentResultByKey.get(key)
  if (cached) return cached.result
  const existingInflight = inflightByKey.get(key)
  if (existingInflight) return existingInflight

  const work = (async (): Promise<{ uri: string; cid: string }> => {
    // 3. Mint per-DID PDS session
    const secret = await getSecret()
    const session = await mintFirstPartySessionFor(email, match.did, {
      ...depsBase,
      secret,
    })
    if (!session) throw new McpToolError('not_entitled')

    // 4. Optionally upload embed images
    const fetchImpl = __testOnly__.fetchImpl
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: input.text,
      createdAt: new Date().toISOString(),
    }
    if (input.reply_to) {
      record.reply = {
        root: { uri: input.reply_to.root_uri, cid: input.reply_to.root_cid },
        parent: { uri: input.reply_to.parent_uri, cid: input.reply_to.parent_cid },
      }
    }

    const images = input.embed?.images ?? []
    if (images.length > 0) {
      const uploadedImages: Array<{ image: unknown; alt: string }> = []
      for (const img of images) {
        const bytes = Buffer.from(img.bytes_b64, 'base64')
        if (bytes.length > MAX_IMAGE_BYTES) {
          throw new McpToolError('payload_too_large', { limit: MAX_IMAGE_BYTES, size: bytes.length })
        }
        let uploadRes: any
        try {
          uploadRes = await pdsFetch(
            'POST',
            '/xrpc/com.atproto.repo.uploadBlob',
            session.accessJwt,
            new Uint8Array(bytes),
            { contentType: img.mime, fetchImpl },
          )
        } catch (e) {
          if (e instanceof PdsHttpError) {
            throw new McpToolError('pds_error', { status: e.status, body: e.body })
          }
          throw e
        }
        // PDS returns { blob: { $type, ref: { $link }, mimeType, size } }.
        // Keep the full blob object so the embed carries the IPLD-JSON $link CID.
        uploadedImages.push({ image: uploadRes?.blob, alt: img.alt })
      }
      record.embed = {
        $type: 'app.bsky.embed.images',
        images: uploadedImages,
      }
    }

    // 5. createRecord
    let createRes: any
    try {
      createRes = await pdsFetch(
        'POST',
        '/xrpc/com.atproto.repo.createRecord',
        session.accessJwt,
        {
          repo: match.did,
          collection: 'app.bsky.feed.post',
          record,
        },
        { fetchImpl },
      )
    } catch (e) {
      if (e instanceof PdsHttpError) {
        throw new McpToolError('pds_error', { status: e.status, body: e.body })
      }
      throw e
    }

    return { uri: createRes.uri, cid: createRes.cid }
  })()

  inflightByKey.set(key, work)
  try {
    const result = await work
    recentResultByKey.set(key, { result, expiresAt: now + IDEMPOTENCY_TTL_MS })
    return result
  } finally {
    inflightByKey.delete(key)
  }
}
