export type Proof = { kind: 'txt'; value: string } | { kind: 'wellknown'; value: string }

export function parseHandleProof(p: Proof, expectedDid: string): boolean {
  if (p.kind === 'txt') {
    const m = p.value.trim().match(/^did=(.+)$/)
    return !!m && m[1].trim() === expectedDid
  }
  return p.value.trim() === expectedDid
}

export interface HandleResolver {
  txt(host: string): Promise<string[]>
  wellknown(host: string): Promise<string | null>
}

/** True iff the user's domain proves control of expectedDid via TXT or .well-known. */
export async function verifyHandleControls(
  handle: string,
  expectedDid: string,
  r: HandleResolver,
): Promise<boolean> {
  try {
    for (const v of await r.txt(`_atproto.${handle}`)) {
      if (parseHandleProof({ kind: 'txt', value: v }, expectedDid)) return true
    }
  } catch { /* fall through to well-known */ }
  try {
    const body = await r.wellknown(handle)
    if (body && parseHandleProof({ kind: 'wellknown', value: body }, expectedDid)) return true
  } catch { /* not verified */ }
  return false
}
