// SINGLE source of the legacy-apex storage-key special-case (Approach B).
// Apex (did:web:serverless.social, the pre-multi-tenant singleton) keeps the
// EXACT historical key strings so the live federated repo is byte-untouched.
import { HANDLE } from './lexicons'

export const APEX_DID = `did:web:${HANDLE}`

export type KeyKind = 'root' | 'block' | 'record'

const isApex = (did: string): boolean => did === APEX_DID

/** Returns the DynamoDB {pk,sk} for a repo key, tenant-aware. */
export function keyFor(did: string, kind: 'root'): { pk: string; sk: string }
export function keyFor(did: string, kind: 'block' | 'record', arg: string): { pk: string; sk: string }
export function keyFor(did: string, kind: KeyKind, arg?: string): { pk: string; sk: string }
export function keyFor(did: string, kind: KeyKind, arg?: string): { pk: string; sk: string } {
  if (kind === 'root') {
    return isApex(did)
      ? { pk: 'ACCOUNT', sk: 'ACCOUNT' }
      : { pk: `${did}#ACCOUNT`, sk: 'ACCOUNT' }
  }
  if (kind === 'record') {
    // Realizes the documented `RECORD#<collection>/<rkey> -> {cid, rev}` layout
    // (pds-table.ts:18). `arg` is the string `${collection}/${rkey}`.
    //
    // The apex pk is EXACTLY `RECORD#<collection>/<rkey>` — byte-matching the
    // Spec #1 longform render-on-write DDB-stream ESM filter prefix
    // `RECORD#social.serverless.longform/` (infra-stack.ts) so the renderer
    // fires. Sub-users stay `<did>#`-prefixed and are correctly ignored by the
    // apex-only renderer. This is a NEW, separate pk namespace — it does NOT
    // touch the legacy apex 'root'/'block' keys, so the apex repo and its
    // firehose frames remain byte-identical.
    const arg2 = arg as string
    return isApex(did)
      ? { pk: `RECORD#${arg2}`, sk: 'RECORD' }
      : { pk: `${did}#RECORD#${arg2}`, sk: 'RECORD' }
  }
  // block
  const cid = arg as string
  return isApex(did)
    ? { pk: `BLOCK#${cid}`, sk: 'BLOCK' }
    : { pk: `${did}#BLOCK#${cid}`, sk: 'BLOCK' }
}

/** Inverse of keyFor('block') pk → the cid string. */
export function parseBlockCid(did: string, pk: string): string {
  const prefix = isApex(did) ? 'BLOCK#' : `${did}#BLOCK#`
  if (!pk.startsWith(prefix)) throw new Error(`pk ${pk} not a block key for ${did}`)
  return pk.slice(prefix.length)
}
