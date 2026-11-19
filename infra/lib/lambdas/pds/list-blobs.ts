/**
 * list-blobs.ts — pure blob-CID extraction for com.atproto.sync.listBlobs.
 *
 * A migrated account must be repo-portable: every blob it references has to be
 * enumerable for backup / relay / re-migration. listBlobs returns the set of
 * blob CIDs reachable from a repo's record values. This module is the pure,
 * I/O-free core: it walks decoded record values and harvests blob-ref CIDs.
 *
 * ── Blob-ref representation (the load-bearing decision) ────────────────────
 *
 * A blob ref appears in a record in TWO equivalent shapes depending on how the
 * record value reached us:
 *
 *   1. JSON form   — `{ $type:'blob', ref:{ $link:'<cidStr>' }, mimeType, size }`
 *                    (records that arrived/were normalized as plain JSON; also
 *                     the canonical XRPC wire shape `cidToBlobRef` emits).
 *   2. Lex/CBOR form — `{ $type:'blob', ref:<CID instance>, mimeType, size }`
 *                    (what `repo.storage.readRecord` → `cborToLexRecord`
 *                     produces: `ref` is an `@atproto` CID object, not `{$link}`).
 *
 * `repo-read.listRecords` decodes via `cborToLexRecord`, so the handler path
 * yields form #2; the wire/JSON path (and the pinned contract tests) use #1.
 * A faithful enumerator MUST handle BOTH — missing either silently drops blobs
 * from a migrated account.
 *
 * Why a hand-rolled structural detector instead of an `@atproto` util:
 *   - `@atproto/lex-json`'s `parseTypedBlobRef` handles both forms, but it is
 *     NOT re-exported from the package index (only bytes/json/lex-json/link),
 *     so it isn't importable without reaching into dist internals.
 *   - All canonical parsers (`parseTypedBlobRef`, `parseLexLink`,
 *     `BlobRef.asBlobRef`) run the string through `parseCid`, which *validates
 *     CID syntax* and throws on non-CID strings. listBlobs is a structural
 *     enumeration, not a CID validator — and the pinned contract tests use
 *     synthetic placeholder strings ('bafkreia', 'bafkrei1', …) that are not
 *     syntactically valid CIDs. A strict parser would reject the contract.
 *   - `@atproto/lex-data`'s re-exported `CID` (this is multiformats' CID;
 *     `@atproto/lex-data` is already a dep — see the import below) exposes
 *     `CID.asCID`, a pure structural check (no parse/throw). We use it to
 *     recognize the form-#2 CID-instance `ref` exactly, and a direct
 *     `ref.$link` string check for form #1.
 *
 * No I/O. Defensive against null / non-objects. AT-Proto records are acyclic
 * JSON-like trees; a plain recursive walk over arrays/objects is sufficient.
 */

// `@atproto/lex-data` re-exports multiformats' `CID` (already a dep; same
// `CID.asCID` structural recognizer used by storage.ts/repo-import.ts).
import { CID } from '@atproto/lex-data'

/** True if `v` is a non-null object (and not an array). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * If `value` is a blob ref (either wire shape), return its CID string;
 * otherwise return undefined. Pure structural detection — does NOT validate
 * CID syntax (see module header rationale).
 */
function blobRefCidStr(value: unknown): string | undefined {
  if (!isObject(value)) return undefined
  if (value.$type !== 'blob') return undefined
  const ref = value.ref
  if (ref == null) return undefined

  // Form #2 — lex/CBOR: `ref` is a CID instance. CID.asCID is a pure
  // structural recognizer (no parse, no throw); returns the CID or null.
  const asCid = CID.asCID(ref as object)
  if (asCid) return asCid.toString()

  // Form #1 — JSON: `ref` is `{ $link: '<cidStr>' }`.
  if (isObject(ref) && typeof ref.$link === 'string' && ref.$link.length > 0) {
    return ref.$link
  }

  return undefined
}

/**
 * Recursively walk a decoded record value and return the deduped set of blob
 * CID strings it references. Order is insertion order of first sighting; the
 * caller is responsible for any deterministic ordering it needs.
 *
 * Detects blob refs in both the JSON `{$link}` form and the lex/CBOR
 * CID-instance form, at any depth, inside objects and arrays.
 */
export function extractBlobCids(value: unknown): string[] {
  const out = new Set<string>()

  const walk = (node: unknown): void => {
    if (node == null) return

    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }

    if (isObject(node)) {
      // A blob ref is itself an object; harvest it, then still descend so a
      // (malformed/nested) blob inside it isn't missed. A well-formed blob
      // ref has only scalar children, so the extra descent is cheap & safe.
      const cid = blobRefCidStr(node)
      if (cid !== undefined) out.add(cid)
      for (const k of Object.keys(node)) walk(node[k])
      return
    }

    // scalars (string/number/boolean) — nothing to do
  }

  walk(value)
  return [...out]
}

/**
 * Union the blob CIDs across many decoded record values, dedup, and return a
 * DETERMINISTIC stable-sorted list. The stable sort is load-bearing: it makes
 * listBlobs pagination (opaque last-cid cursor) and the migration live-proof
 * fingerprint reproducible across invocations.
 */
export function collectRepoBlobCids(recordValues: unknown[]): string[] {
  const all = new Set<string>()
  for (const rv of recordValues) {
    for (const cid of extractBlobCids(rv)) all.add(cid)
  }
  return [...all].sort()
}
