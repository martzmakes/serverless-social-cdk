// `@atproto/lex-data` re-exports multiformats' `CID` (same class instance,
// same `CID.asCID` structural recognizer). Identical to the import idiom in
// `list-blobs.ts:48` — used here in place of `multiformats/cid` because the
// `multiformats@9.9.0` package.json `exports` map omits a `types` resolution
// for the `./cid` subpath, which makes the direct import fail under
// `moduleResolution: NodeNext`. Runtime semantics are identical.
import { CID } from '@atproto/lex-data'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function normalizeCidsToIpldJson<T>(value: T): T {
  // CID instance → { $link }
  const asCid = CID.asCID(value as object | null)
  if (asCid) {
    return { $link: asCid.toString() } as unknown as T
  }
  // Arrays
  if (Array.isArray(value)) {
    let changed = false
    const out = (value as unknown[]).map((item) => {
      const next = normalizeCidsToIpldJson(item)
      if (next !== item) changed = true
      return next
    })
    return (changed ? out : value) as unknown as T
  }
  // Objects (already-normalized { $link: string } is a plain object and walks through inertly)
  if (isObject(value)) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[k]
      const next = normalizeCidsToIpldJson(v)
      if (next !== v) changed = true
      out[k] = next
    }
    return (changed ? out : value) as unknown as T
  }
  // Primitives + null
  return value
}
