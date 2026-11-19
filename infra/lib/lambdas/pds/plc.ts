import { Secp256k1Keypair } from '@atproto/crypto'
import { encode as cborEncode, cidForLex } from '@atproto/lex-cbor'
import { sha256 } from '@atproto/crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GenesisInput {
  signingKeyDid: string
  rotationKeyDids: string[]
  handle: string
  pdsEndpoint: string
}

export interface UpdateInput {
  prev: string
  rotationKeyDids: string[]
  signingKeyDid: string
  handle: string
  pdsEndpoint: string
}

export interface UnsignedOp {
  type: 'plc_operation'
  rotationKeys: string[]
  verificationMethods: { atproto: string }
  alsoKnownAs: string[]
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer'; endpoint: string } }
  prev: null
}

/**
 * A non-genesis, prev-chained PLC update operation. Structurally identical to
 * {@link UnsignedOp} except `prev` is the CID string of the DID's most-recent
 * PLC log entry (instead of `null` for genesis).
 */
export interface UnsignedUpdateOp {
  type: 'plc_operation'
  rotationKeys: string[]
  verificationMethods: { atproto: string }
  alsoKnownAs: string[]
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer'; endpoint: string } }
  prev: string
}

/** Any unsigned op — genesis (`prev:null`) or update (`prev:<cid>`). */
export type AnyUnsignedOp = UnsignedOp | UnsignedUpdateOp

export interface SignedOp extends UnsignedOp {
  sig: string
}

export interface SignedUpdateOp extends UnsignedUpdateOp {
  sig: string
}

export type AnySignedOp = SignedOp | SignedUpdateOp

// ─── Helpers ──────────────────────────────────────────────────────────────────

// RFC 4648 base32 lowercase (no padding) — inlined to avoid multiformats type
// resolution issues under NodeNext moduleResolution (the package's exports map
// omits "types" for sub-path entries, so tsc can't find the .d.ts).
// This exactly matches the multibase 'b' alphabet: a-z2-7.
const BASE32_CHARS = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Encode(input: Uint8Array): string {
  let result = ''
  let bits = 0
  let value = 0
  for (const byte of input) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += BASE32_CHARS[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 0x1f]
  }
  return result
}

const b64url = (b: Uint8Array): string =>
  Buffer.from(b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Build an unsigned did:plc genesis operation (modern v0.2 / tangled form).
 * The unsigned op is passed to `signGenesisOp` before submission to PLC directory.
 */
export function buildGenesisOp(i: GenesisInput): UnsignedOp {
  return {
    type: 'plc_operation',
    rotationKeys: i.rotationKeyDids,
    verificationMethods: { atproto: i.signingKeyDid },
    alsoKnownAs: [`at://${i.handle}`],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: i.pdsEndpoint } },
    prev: null,
  }
}

/**
 * Build an unsigned NON-genesis (prev-chained) did:plc update operation.
 *
 * `prev` MUST be the CID string of the DID's most-recent PLC log entry (the
 * value returned by {@link plcOpCid} for that prior signed op, and the value
 * plc.directory keys that log entry by). The op repoints the signing key
 * (`verificationMethods.atproto`), the PDS endpoint
 * (`services.atproto_pds.endpoint`) and the handle (`alsoKnownAs`).
 *
 * Field ORDER intentionally mirrors `buildGenesisOp` (type, rotationKeys,
 * verificationMethods, alsoKnownAs, services, prev). DAG-CBOR canonically
 * sorts map keys at encode time, so field order here does not affect the CID;
 * it is kept consistent purely for readability.
 */
export function buildUpdateOp(i: UpdateInput): UnsignedUpdateOp {
  return {
    type: 'plc_operation',
    rotationKeys: i.rotationKeyDids,
    verificationMethods: { atproto: i.signingKeyDid },
    alsoKnownAs: [`at://${i.handle}`],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: i.pdsEndpoint } },
    prev: i.prev,
  }
}

/**
 * Canonical CIDv1 string of a signed PLC op — the value the NEXT op uses as
 * its `prev`, and the value plc.directory keys log entries by.
 *
 * Algorithm: dag-cbor-encode(signedOp) → sha2-256 → CIDv1 (codec dag-cbor
 * 0x71, multihash sha2-256) → base32-lower multibase string (`b…`).
 *
 * Uses the exact same `@atproto/lex-cbor` DAG-CBOR encoder as `signGenesisOp`
 * / `plcDidFromSignedOp` (`cidForLex` is literally `cidForCbor(encode(value))`
 * — the same `encode` already imported as `cborEncode` here), so it is
 * byte-identical to the bytes plc.directory hashes. `plcDidFromSignedOp`
 * applies the SAME hash but truncates to a did:plc; this returns the full
 * CIDv1 string instead.
 */
export async function plcOpCid(signed: object): Promise<string> {
  const cid = await cidForLex(signed as Parameters<typeof cidForLex>[0])
  return cid.toString()
}

/**
 * Sign ANY unsigned PLC op (genesis with `prev:null`, or a prev-chained
 * update) with a rotation key.
 *
 * The signature is the raw secp256k1 signature over the dag-cbor encoding of
 * the unsigned op, encoded as base64url (no padding). This is the single,
 * shared signing code path used by both genesis and update operations — the
 * byte-level behavior is exactly what `signGenesisOp` did before, just no
 * longer special-cased to genesis.
 */
export async function signOp<T extends AnyUnsignedOp>(
  op: T,
  rotation: Secp256k1Keypair,
): Promise<T & { sig: string }> {
  const sig = b64url(await rotation.sign(cborEncode(op as unknown as Parameters<typeof cborEncode>[0])))
  return { ...op, sig }
}

/**
 * Sign an unsigned genesis op with the rotation key.
 * Thin wrapper over {@link signOp} — genesis behavior is byte-unchanged.
 */
export async function signGenesisOp(op: UnsignedOp, rotation: Secp256k1Keypair): Promise<SignedOp> {
  return signOp(op, rotation)
}

/**
 * Derive `did:plc:<24-char-base32>` from a signed genesis op.
 *
 * Algorithm (canonical PLC spec):
 *   dag-cbor-encode(signedOp) → sha256 → base32-lowercase → first 24 chars
 *
 * Works for both legacy (v0.1 `type:'create'`) and modern (v0.2 `type:'plc_operation'`) forms
 * because it simply hashes whatever op object is provided.
 */
export async function plcDidFromSignedOp(
  signed: SignedOp | Record<string, unknown>,
): Promise<string> {
  const hash = await sha256(cborEncode(signed as Parameters<typeof cborEncode>[0]))
  return `did:plc:${base32Encode(hash).slice(0, 24)}`
}

/**
 * Submit a signed genesis op to the PLC directory.
 * The DID must be the one derived by `plcDidFromSignedOp` for this exact op.
 */
export async function submitPlcOp(
  did: string,
  signed: AnySignedOp,
  plcUrl = 'https://plc.directory',
): Promise<void> {
  const res = await fetch(`${plcUrl}/${did}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>')
    throw new Error(`PLC submit ${res.status} ${body}`)
  }
}

// ─── PLC Log / Head Resolution ────────────────────────────────────────────────

export interface PlcLogHead {
  prev: string                              // CID of the latest log entry (the next op's `prev`)
  rotationKeys: string[]
  verificationMethods: Record<string, string>
  pdsEndpoint: string
}

/**
 * Resolve the current PLC state for a DID by fetching its `/log/audit` from
 * the PLC directory. Returns the `prev` CID (i.e. the CID of the most-recent
 * log entry — what the NEXT op must reference), plus the rotation keys,
 * verification methods, and PDS endpoint from that head entry.
 *
 * An injected `fetchImpl` parameter allows unit tests to supply a fake
 * implementation without hitting the network.
 */
export async function fetchPlcLogHead(
  did: string,
  plcUrl = 'https://plc.directory',
  fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }> = fetch as any,
): Promise<PlcLogHead> {
  const res = await fetchImpl(`${plcUrl}/${did}/log/audit`)
  if (!res.ok) throw new Error(`plc log/audit ${res.status} for ${did}`)
  const log = (await res.json()) as Array<{ cid: string; operation: any }>
  if (!Array.isArray(log) || log.length === 0) throw new Error(`empty PLC log for ${did}`)
  const head = log[log.length - 1]                          // latest entry
  const op = head.operation ?? {}
  return {
    prev: head.cid,
    rotationKeys: op.rotationKeys ?? [],
    verificationMethods: op.verificationMethods ?? {},
    pdsEndpoint: op.services?.atproto_pds?.endpoint ?? '',
  }
}
