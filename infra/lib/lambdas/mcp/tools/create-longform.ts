/**
 * create-longform.ts — `create_longform` MCP tool (Spec #6 T7).
 *
 * Flow (mirrors create-post.ts):
 *   1. Validate input shape (account, title, content all non-empty strings).
 *   2. Resolve caller's entitlements; match `account` against DID or handle.
 *      No match → McpToolError('not_entitled').
 *   3. Mint per-DID PDS session via mintFirstPartySessionFor. null →
 *      McpToolError('not_entitled') (race: tenant deactivated between resolve
 *      and re-query).
 *   4. Slug: caller-supplied (trim, used VERBATIM per Spec #5b full-slug
 *      parity — NO re-safeSlug, NO truncation) OR safeSlug(title).
 *   5. Optionally uploadBlob the cover image (base64 → bytes, reject if
 *      >7.5MB raw). Set record.cover = {image: <blob>, alt}.
 *   6. POST createRecord to social.serverless.longform.
 *   7. Map PdsHttpError: 409 → 'slug_conflict' (LLM picks a different slug +
 *      retries), other statuses → 'pds_error'.
 *   8. canonical_url = https://<ent.handle>/<slug>. Render is ASYNC: the
 *      existing DDB-stream consumer (pds/storage.ts:185-186) filters on
 *      RECORD#social.serverless.longform/ and re-reads the record to render
 *      the static HTML. `render_pending: true` signals the URL may 404
 *      briefly until that catches up.
 *
 * safeSlug is the SAME helper used by the renderer (longform-routing.ts) —
 * single source of truth for slug normalization across write + render paths.
 *
 * Idempotency (dup-post hardening, docs/audit-2026-09-01): despite the
 * doc-comment in step 7 below, `com.atproto.repo.createRecord` in this PDS
 * (infra/lib/lambdas/pds/repo-write.ts) does NOT enforce slug uniqueness —
 * it only rejects a re-used *rkey*, which is always a fresh TID here. Two
 * calls with the same `slug` field both succeed and create two live
 * `social.serverless.longform` records with that slug (last-render-wins for
 * routing, per longform-index.ts, but the PDS repo itself now has a
 * duplicate).
 *
 * The guard below ONLY closes the caller-side-retry vector (a client resend
 * of the identical call, e.g. after a Lambda/API GW timeout — same as
 * create-post.ts): the idempotency key fingerprints title+content+slug+etc,
 * so a retry with byte-identical input hits the cache instead of writing a
 * duplicate. It does NOT and cannot close the general case: two calls that
 * legitimately (or accidentally) share the same caller-supplied `slug` but
 * differ in title/content produce a different fingerprint, bypass the cache
 * entirely, and both succeed — see the 'SAME explicit slug, different
 * content' test in create-longform.test.ts. THAT gap is still open and can
 * only be closed by server-side slug-uniqueness enforcement in
 * infra/lib/lambdas/pds/repo-write.ts (owned by the pds/ stream, not this
 * file) — do not report it as resolved.
 * Mirrors create-post.ts's short-lived in-flight + recent-result cache,
 * keyed on everything that determines the resulting record.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

import { resolveApprovedDids } from '../../auth/entitlements'
import { mintFirstPartySessionFor } from '../../auth/session-mint'
import { safeSlug } from '../../pds/longform-routing'
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

// ── Test hook: parallel to create-post.ts pattern (own hook per tool) ────────
export const __testOnly__ = {
  /** Tests inject a stub fetch; production leaves undefined → globalThis.fetch. */
  fetchImpl: undefined as typeof fetch | undefined,
  /** Tests call this in beforeEach to avoid cross-test cache bleed (module-level Maps persist for the file's lifetime). */
  resetIdempotencyCache(): void {
    inflightByKey.clear()
    recentResultByKey.clear()
  },
}

// ── Idempotency cache (see module doc comment above; mirrors create-post.ts) ──
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000 // 5 minutes — comfortably longer than any client retry delay
const inflightByKey = new Map<
  string,
  Promise<{ uri: string; cid: string; canonical_url: string; render_pending: true }>
>()
const recentResultByKey = new Map<
  string,
  { result: { uri: string; cid: string; canonical_url: string; render_pending: true }; expiresAt: number }
>()

function pruneExpired(now: number): void {
  for (const [k, v] of recentResultByKey) {
    if (v.expiresAt <= now) recentResultByKey.delete(k)
  }
}

/** Fingerprint of everything that determines the resulting record — keyed on the RESOLVED did (not the caller's did/handle string). */
function idempotencyKey(did: string, input: CreateLongformInput): string {
  return JSON.stringify({
    did,
    title: input.title,
    content: input.content,
    slug: input.slug ?? null,
    excerpt: input.excerpt ?? null,
    tags: input.tags ?? null,
    syndicate: input.syndicate === true,
    syndication_teaser: input.syndication_teaser ?? null,
    cover: input.cover ?? null,
  })
}

// ── Public surface ───────────────────────────────────────────────────────────
export type CreateLongformInput = {
  /** DID or handle from list_accounts. */
  account: string
  title: string
  /** Markdown body. Stored as record.content — the field the renderer reads. */
  content: string
  /** Optional caller-supplied slug — used VERBATIM (after trim) per Spec #5b. */
  slug?: string
  /** Optional short summary (drives meta description + syndication teaser). */
  excerpt?: string
  tags?: string[]
  /**
   * Whether to POSSE a Bluesky syndication post on render. DEFAULT false —
   * an AI-driven tool must not blast a tenant's followers unless explicitly
   * asked. (The renderer treats `syndicate !== false` as opt-in, so we always
   * write an explicit boolean.)
   */
  syndicate?: boolean
  syndication_teaser?: string
  cover?: { bytes_b64: string; mime: string; alt: string }
}

// ── Deps builder (env reads; mirrors create-post.ts) ─────────────────────────
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

// API GW base64-inflates ~33% → ~7.5 MB raw keeps us under the 10 MB request cap.
const MAX_IMAGE_BYTES = 7_500_000

export async function createLongformTool(
  email: string,
  input: CreateLongformInput,
): Promise<{ uri: string; cid: string; canonical_url: string; render_pending: true }> {
  // 1. Input shape validation
  if (
    !input ||
    typeof input.account !== 'string' ||
    input.account.length === 0 ||
    typeof input.title !== 'string' ||
    input.title.length === 0 ||
    typeof input.content !== 'string' ||
    input.content.length === 0
  ) {
    throw new McpToolError('invalid_account')
  }

  // 2. Build deps + resolve entitlements
  const depsBase = buildDepsBase()
  const ents = await resolveApprovedDids(email, depsBase)
  const match = ents.find((e) => e.did === input.account || e.handle === input.account)
  if (!match) throw new McpToolError('not_entitled')

  // 2b. Idempotency check — see module doc comment. A retry of the SAME
  // logical call within the TTL returns the original result instead of
  // writing a duplicate longform record.
  const key = idempotencyKey(match.did, input)
  const now = Date.now()
  pruneExpired(now)
  const cached = recentResultByKey.get(key)
  if (cached) return cached.result
  const existingInflight = inflightByKey.get(key)
  if (existingInflight) return existingInflight

  const work = (async (): Promise<{
    uri: string
    cid: string
    canonical_url: string
    render_pending: true
  }> => {
    // 3. Mint per-DID PDS session
    const secret = await getSecret()
    const session = await mintFirstPartySessionFor(email, match.did, {
      ...depsBase,
      secret,
    })
    if (!session) throw new McpToolError('not_entitled')

    // 4. Slug resolution — caller's verbatim (post-trim), else derived from title.
    // NO re-safeSlug on caller-supplied slug: #5b parity rule allows existing
    // long/legacy slugs (>64 chars, etc.) to round-trip exactly. safeSlug used
    // ONLY when we're generating from title.
    const slug = input.slug?.trim() || safeSlug(input.title)

    const fetchImpl = __testOnly__.fetchImpl

    // 5. Optional cover upload
    // Canonical longform shape the static renderer (longform-render.ts) reads:
    // `content` (NOT body_markdown), plus optional excerpt/tags, and an explicit
    // `syndicate` boolean (default false — never POSSE unless asked).
    const record: Record<string, unknown> = {
      $type: 'social.serverless.longform',
      title: input.title,
      content: input.content,
      slug,
      syndicate: input.syndicate === true,
      createdAt: new Date().toISOString(),
    }
    if (typeof input.excerpt === 'string' && input.excerpt.length > 0) {
      record.excerpt = input.excerpt
    }
    if (Array.isArray(input.tags) && input.tags.length > 0) {
      record.tags = input.tags
    }
    if (typeof input.syndication_teaser === 'string' && input.syndication_teaser.length > 0) {
      record.syndicationTeaser = input.syndication_teaser
    }

    if (input.cover) {
      const bytes = Buffer.from(input.cover.bytes_b64, 'base64')
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
          { contentType: input.cover.mime, fetchImpl },
        )
      } catch (e) {
        if (e instanceof PdsHttpError) {
          throw new McpToolError('pds_error', { status: e.status, body: e.body })
        }
        throw e
      }
      // PDS returns { blob: { $type, ref: { $link }, mimeType, size } } —
      // keep the full blob object so the record carries the IPLD-JSON $link CID.
      record.cover = { image: uploadRes?.blob, alt: input.cover.alt }
    }

    // 6. createRecord
    let createRes: any
    try {
      createRes = await pdsFetch(
        'POST',
        '/xrpc/com.atproto.repo.createRecord',
        session.accessJwt,
        {
          repo: match.did,
          collection: 'social.serverless.longform',
          record,
        },
        { fetchImpl },
      )
    } catch (e) {
      if (e instanceof PdsHttpError) {
        // 409 = slug already taken in this repo → distinct code so the LLM can
        // pick a different slug and retry without escalating to a generic error.
        if (e.status === 409) {
          throw new McpToolError('slug_conflict', { status: e.status, body: e.body })
        }
        throw new McpToolError('pds_error', { status: e.status, body: e.body })
      }
      throw e
    }

    // 7. canonical_url. Render is async via DDB-stream consumer (pds/storage.ts);
    // render_pending signals the URL may 404 briefly until the renderer catches up.
    const canonical_url = `https://${match.handle}/${slug}`
    return {
      uri: createRes.uri,
      cid: createRes.cid,
      canonical_url,
      render_pending: true,
    }
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
