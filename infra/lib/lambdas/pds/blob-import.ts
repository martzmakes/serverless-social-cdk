import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { blobCid } from './blobs'

/** Minimal structural fetch contract shared by listSourceBlobs / fetchSourceBlob /
 *  migrateBlobs. The real global `fetch` satisfies it; tests inject a string-URL mock. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean
  status: number
  json?: () => Promise<any>
  text?: () => Promise<string>
  arrayBuffer?: () => Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}>

/** Recompute the content CID, fail-closed on mismatch, idempotently store under
 *  blobs/<cid> (content-addressed — mirrors blobs.ts putBlob's key + metadata
 *  exactly). 'skipped' if already present. The per-blob analogue of
 *  repo-import.ts parseAndVerifyCar: nothing is stored until the bytes are
 *  proven to hash to the source-listed CID. */
export async function verifyAndStoreBlob(
  bytes: Uint8Array,
  expectedCidStr: string,
  s3: S3Client,
  bucket: string,
  mimeType = 'application/octet-stream',
): Promise<'stored' | 'skipped'> {
  const actual = (await blobCid(bytes)).toString()
  if (actual !== expectedCidStr) {
    throw new Error(
      `blob CID mismatch: bytes hash to ${actual} but source listed ${expectedCidStr} — refusing to store (fail-closed)`,
    )
  }
  const Key = `blobs/${expectedCidStr}`
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }))
    return 'skipped'
  } catch (e: any) {
    if (!(e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404)) throw e
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key,
      Body: bytes,
      ContentType: mimeType,
      Metadata: { 'atproto-cid': expectedCidStr },
    }),
  )
  return 'stored'
}

/** Defensive page cap so a misbehaving source PDS returning an ever-advancing
 *  cursor can't drive an unbounded pagination loop. Mirrors import-longform.ts's
 *  HASHNODE_MAX_PAGES guard. With limit=500 this bounds enumeration at 100k
 *  blobs before the truncation error fires. */
const MAX_PAGES = 200

/** Enumerate every blob CID a source PDS lists for `did` via the public
 *  `com.atproto.sync.listBlobs` XRPC, following the cursor to exhaustion.
 *
 *  Termination is load-bearing — a real PDS can return a stuck/non-advancing
 *  cursor. The loop stops on ANY of: no cursor, a non-advancing cursor (equal
 *  to the previous one), or a page that yielded zero new cids. If the hard
 *  MAX_PAGES cap is hit while the cursor is STILL advancing we THROW a clear
 *  truncation error rather than silently returning a partial list (never drop
 *  blobs — the per-blob analogue of import-longform.ts's `partial` surfacing).
 *
 *  Pure aside from the injected `fetchImpl` (defaults to global `fetch`). */
export async function listSourceBlobs(
  sourcePds: string,
  did: string,
  // Structural fetch-shape (not `typeof fetch`): the production caller passes
  // global `fetch`, while unit tests inject a string-URL mock. We only ever
  // call it with a string URL and only read ok/status/json/text here — the
  // shared FetchLike superset (also covers fetchSourceBlob/migrateBlobs) is
  // the honest module-wide contract.
  fetchImpl: FetchLike = fetch as any,
): Promise<string[]> {
  const cids: string[] = []
  const seen = new Set<string>()
  // `cursor` = the cursor used for the request we're ABOUT to make (undefined
  // on the first page). We detect a stuck/non-advancing PDS two ways: the
  // returned cursor equals the one we just sent, OR the page contributed zero
  // NEW cids (a PDS handing back a fresh-looking cursor but the same blob set —
  // refetching would loop forever).
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `${sourcePds}/xrpc/com.atproto.sync.listBlobs?did=${encodeURIComponent(did)}&limit=500`
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`

    const res = await fetchImpl(url)
    if (!res.ok) {
      const detail = res.text ? await res.text() : ''
      throw new Error(`listBlobs ${res.status}: ${detail}`)
    }

    const body: any = res.json ? await res.json() : {}
    const pageCids: string[] = Array.isArray(body?.cids) ? body.cids : []
    let newThisPage = 0
    for (const c of pageCids) {
      if (!seen.has(c)) {
        seen.add(c)
        cids.push(c)
        newThisPage++
      }
    }

    const nextCursor: string | undefined = body?.cursor || undefined

    // Terminate: no further cursor, the cursor did not advance past the one we
    // just sent (stuck PDS), OR the page contributed zero NEW cids (no forward
    // progress). Any of these means refetching would loop forever — stop.
    if (!nextCursor || nextCursor === cursor || newThisPage === 0) {
      return cids
    }

    cursor = nextCursor
  }

  // Hit the hard cap while the cursor was STILL advancing — refuse to silently
  // truncate. Surface it so a partial enumeration is never mistaken for total.
  throw new Error(
    `listBlobs exceeded ${MAX_PAGES}-page cap with an advancing cursor — source enumeration is INCOMPLETE; refusing to return a truncated blob list`,
  )
}

/** Fetch one blob's raw bytes + content-type from a source PDS via the public
 *  `com.atproto.sync.getBlob` XRPC (GET, no auth — mirrors what handler.ts's
 *  getBlob case returns: a binary body + content-type header). The fetched
 *  bytes are NOT trusted here — the caller hands them to verifyAndStoreBlob,
 *  which recomputes the CID and fails closed on mismatch.
 *
 *  Non-200 throws with status + body (same error idiom as listSourceBlobs).
 *  mimeType defaults to application/octet-stream when the source omits a
 *  content-type, matching the handler's own getBlob fallback.
 *
 *  Pure aside from the injected `fetchImpl` (defaults to global `fetch`); uses
 *  the shared module-wide FetchLike contract. */
export async function fetchSourceBlob(
  sourcePds: string,
  did: string,
  cid: string,
  fetchImpl: FetchLike = fetch as any,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const url = `${sourcePds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`

  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new Error(`getBlob ${res.status}: ${res.text ? await res.text() : ''}`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer!())
  const mimeType = res.headers?.get('content-type') ?? 'application/octet-stream'
  return { bytes, mimeType }
}

/** The result of a whole-account blob migration. Invariant:
 *  `total === stored + skipped + failed.length`. `failed` is the list of
 *  source-listed CIDs that did NOT migrate (a getBlob/network error OR a
 *  fail-closed CID mismatch — nothing was stored for any of them). A non-empty
 *  `failed` is caller-fatal (Task 4 aborts activation before flipping the
 *  account live) — but `migrateBlobs` itself never throws on a per-blob
 *  failure; it returns the full summary so the caller can decide. */
export interface MigrateBlobsSummary {
  total: number
  stored: number
  skipped: number
  failed: string[]
}

/** Orchestrate a whole-account blob migration by composing the three vetted
 *  primitives: enumerate every source CID (listSourceBlobs), then for each one
 *  fetch its bytes (fetchSourceBlob) and content-verify + idempotently store
 *  them (verifyAndStoreBlob). Per-blob fail-closed: a fetch error OR a CID
 *  mismatch records the cid in `failed[]` and the loop CONTINUES — one bad blob
 *  never aborts the batch, and nothing is ever stored for a failed cid
 *  (verifyAndStoreBlob throws pre-Put on mismatch; fetchSourceBlob throws
 *  before any store on a fetch error). An enumeration (listSourceBlobs) error
 *  is a TOTAL failure and is allowed to propagate. Idempotent: a re-run finds
 *  every blob already present and reports them all `skipped` with zero Put.
 *
 *  Touches ONLY the explicitly-passed `did`'s blobs, addressed purely by
 *  content CID — no apex/tenant/handle coupling.
 *
 *  Pure aside from the injected `deps.fetchImpl` (defaults to global `fetch`
 *  inside the composed primitives) and the passed S3 client. */
export async function migrateBlobs(
  did: string,
  sourcePds: string,
  s3: S3Client,
  bucket: string,
  deps: { fetchImpl?: FetchLike },
): Promise<MigrateBlobsSummary> {
  // An enumeration failure is a TOTAL failure — let it propagate (not per-blob).
  const cids = await listSourceBlobs(sourcePds, did, deps.fetchImpl)

  const total = cids.length
  let stored = 0
  let skipped = 0
  const failed: string[] = []

  for (const cid of cids) {
    try {
      const { bytes, mimeType } = await fetchSourceBlob(sourcePds, did, cid, deps.fetchImpl)
      const r = await verifyAndStoreBlob(bytes, cid, s3, bucket, mimeType)
      if (r === 'stored') stored++
      else skipped++
    } catch {
      // Per-blob fail-closed: a getBlob error OR a CID mismatch. Nothing was
      // stored for this cid. Record it and continue — migrate the rest.
      failed.push(cid)
    }
  }

  return { total, stored, skipped, failed }
}

/** Pure abort seam for the migrate pipeline (Task 4). A blob step is fatal iff
 *  ANY source-listed CID failed to migrate. A clean run (failed=[]) — whether
 *  freshly stored or an idempotent all-skipped re-run — is NOT fatal. The
 *  migrate CLI uses this to refuse activation when blobs are missing (no
 *  activation with missing blobs → no degraded serving window). Identity-
 *  neutral: looks only at the content-addressed summary, no apex/tenant/A5
 *  coupling. */
export function blobStepIsFatal(summary: MigrateBlobsSummary): boolean {
  return summary.failed.length > 0
}
