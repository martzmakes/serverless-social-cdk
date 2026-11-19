/**
 * sequencer.ts — ordered, relay-verifiable AT Protocol #commit event log.
 *
 * This is the correctness-critical core of the Phase-2 firehose. Every repo
 * write produces a `#commit` frame that must be byte-compatible with what a
 * Bluesky relay (e.g. bsky.network / indigo) cryptographically verifies, or
 * federation silently fails.
 *
 * ── Wire format (derived from the reference implementation) ──────────────────
 *
 * A subscribeRepos frame is TWO concatenated DAG-CBOR objects in one binary
 * blob — exactly `Buffer.concat([cborEncode(header), cborEncode(body)])`:
 *
 *   header = { op: 1, t: '#commit' }
 *   body   = { seq, time, repo, commit, rev, since, blocks, ops,
 *              blobs:[], rebase:false, tooBig:false, prevData? }
 *
 * Reference files this was derived from (~/dev/atproto, ~/dev/indigo):
 *   - packages/pds/src/sequencer/events.ts  `formatSeqCommit`
 *       → body fields: repo, commit, rev, since,
 *         blocks = blocksToCarFile(commit.cid, newBlocks ∪ relevantBlocks),
 *         ops, prevData?, rebase:false, tooBig:false, blobs:[]
 *   - packages/pds/src/api/com/atproto/sync/subscribeRepos.ts
 *       → wire body = { seq, time, ...evt } ($type stripped → header.t)
 *   - packages/xrpc-server/src/stream/frames.ts  `Frame.toBytes`
 *       → Buffer.concat([encode(header), encode(body)]) via @atproto/lex-cbor
 *   - packages/xrpc-server/src/stream/types.ts
 *       → MessageFrame header = { op: FrameType.Message=1, t }
 *   - @atproto/repo/dist/util.js  `verifyCommitSig`
 *       → const {sig, ...rest}=commit; verifySignature(didKey, encode(rest), sig)
 *   - indigo atproto/repo/commit.go  `Commit.VerifySignature` / car.go
 *       `LoadCommitFromCAR` — relay loads the commit block out of `blocks`
 *       (the CAR), strips `sig`, re-encodes DAG-CBOR, verifies secp256k1.
 *
 * The diff `blocks` CAR is reconstructed with the SAME algorithm as
 * @atproto/repo's `Repo.formatCommit`: new MST nodes + new record leaves +
 * covering proofs for each touched key + the signed commit block, root = the
 * commit CID. Identical block-set → identical bytes the relay verifies.
 *
 * cbor: `@atproto/lex-cbor` (the exact module @atproto uses everywhere — no
 * hand-rolled cbor, no new dependency).
 * CAR:  `@atproto/repo` `blocksToCarFile` / `readCar`.
 * crypto: `@atproto/crypto` `verifySignature` (ES256K — the relay's check).
 */

import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import { encode as cborEncode, decodeAll as cborDecodeAll } from '@atproto/lex-cbor'
import {
  BlockMap,
  DataDiff,
  MST,
  blocksToCarFile,
  readCar,
} from '@atproto/repo'
import type { Repo } from '@atproto/repo'
import { verifySignature } from '@atproto/crypto'
import { CID } from '@atproto/lex-data'
import { APEX_DID } from './tenant-keys'

type Cid = InstanceType<typeof CID>

// ── DynamoDB key layout (mirrors RepoTable construct) ────────────────────────
//   SEQ/SEQ                 → { value:Number }            (atomic ADD counter)
//   COMMIT#<pad16(seq)>/COMMIT → { cid, rev, data, ts }   (head history + diff base)
//   EVT#<pad16(seq)>/EVT    → { frame:Binary, seq:Number, ttl } (firehose replay)
const SEQ_PK = 'SEQ'
const SEQ_SK = 'SEQ'
const EVT_SK = 'EVT'
const COMMIT_SK = 'COMMIT'

const EVT_TTL_SECONDS = 7 * 24 * 60 * 60 // 7d replay window

/** Zero-padded seq for lexicographically-ordered range keys. */
const pad16 = (seq: number): string => seq.toString().padStart(16, '0')
const evtPk = (seq: number): string => `EVT#${pad16(seq)}`
const commitPk = (seq: number): string => `COMMIT#${pad16(seq)}`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeqOpAction = 'create' | 'update' | 'delete'

export type SeqOpInput = {
  action: SeqOpAction
  collection: string
  rkey: string
}

export type CommitEvtOp = {
  action: SeqOpAction
  /** "<collection>/<rkey>" */
  path: string
  cid: Cid | null
  prev: Cid | null
}

export type CommitEvtBody = {
  seq: number
  time: string
  repo: string
  commit: Cid
  rev: string
  since: string | null
  blocks: Uint8Array
  ops: CommitEvtOp[]
  blobs: Cid[]
  rebase: boolean
  tooBig: boolean
  prevData?: Cid
}

// DynamoDB caps a single item at 400KB. The EVT# firehose frame is ONE item, and
// its `blocks` is a CARv1 of the commit's diff. A full-resync diff (emitted on a
// cross-tenant boundary — see the since/prevDataCid logic below) bundles the
// ENTIRE repo into that CAR; for a large repo (e.g. a migrated blog archive) it
// can exceed 400KB and the write fails (`ValidationException: Item size has
// exceeded the maximum allowed size`), hard-blocking ALL writes to that repo.
// Headroom below 400KB for the header + ops + ttl + DDB attribute overhead.
export const DEFAULT_MAX_INLINE_CAR_BYTES = 360_000

/**
 * Pick the firehose frame's `blocks`/`ops`/`tooBig` under the DynamoDB item cap.
 * - CAR within the cap → inline the full diff + ops (`tooBig:false`). This is the
 *   normal path and is BYTE-IDENTICAL to the pre-guard behavior, so apex
 *   `did:web:serverless.social` frames (tiny repo, always under the cap) are
 *   unchanged — the cardinal byte-lock holds.
 * - CAR over the cap → emit a spec-compliant `tooBig` frame: commit block ONLY
 *   (relay can still load + verify the signed commit) + empty ops. The relay
 *   then resyncs the repo via `com.atproto.sync.getRepo` (implemented).
 * Pure (no I/O) so it is unit-testable without DynamoDB Local.
 */
export function selectFrameBlocks(
  fullCar: Uint8Array,
  commitOnlyCar: Uint8Array,
  evtOps: CommitEvtOp[],
  maxInlineBytes: number,
): { blocks: Uint8Array; ops: CommitEvtOp[]; tooBig: boolean } {
  if (fullCar.byteLength <= maxInlineBytes) {
    return { blocks: fullCar, ops: evtOps, tooBig: false }
  }
  return { blocks: commitOnlyCar, ops: [], tooBig: true }
}

export type ParsedFrame = {
  header: { op: number; t: string }
  body: CommitEvtBody
}

export type SequenceCommitInput = {
  did: string
  repo: Repo
  ops: SeqOpInput[]
  /**
   * The repo's OWN previous commit (rev + MST root CID string), read from the
   * repo before the write was applied. For a non-apex tenant this is the
   * authoritative `since`/`prevData` base: the global COMMIT#(seq-1) row only
   * tells us what ANY tenant did last, so using it made every tenant commit that
   * followed another tenant's commit (or a seq gap) a FULL-REPO resync diff,
   * which for a large repo degrades to `tooBig` + empty ops (AppView indexes
   * nothing). Ignored for the apex DID (its frames stay byte-identical).
   */
  prev?: { rev: string; data: string }
}

// ---------------------------------------------------------------------------
// Diff-block reconstruction
// ---------------------------------------------------------------------------

/**
 * Rebuild the exact set of "diff" blocks that the reference `formatSeqCommit`
 * puts into the firehose CAR: newMstBlocks ∪ new-leaf records ∪ covering
 * proofs for each touched key ∪ the signed commit block. Root = commit CID.
 *
 * `prevDataCid` is the MST root of the *previous* commit (null for the first
 * write after repo creation). Diffing the current MST against it yields the
 * identical block-set the relay expects, so the CAR bytes are wire-compatible.
 */
async function buildDiffBlocks(
  repo: Repo,
  prevDataCid: Cid | null,
  ops: SeqOpInput[],
): Promise<BlockMap> {
  // Accessing @atproto/repo internal fields (storage/data). Stable in 0.9.1; if
  // upstream renames these the MST diff fails at runtime (no TS error) — pinned by sequencer.test.ts.
  const storage = (repo as any).storage
  const currData: MST = (repo as any).data

  const prevData = prevDataCid ? MST.load(storage, prevDataCid) : null
  const diff = await DataDiff.of(currData, prevData)

  const blocks = new BlockMap()
  blocks.addMap(diff.newMstBlocks)

  // New record leaves.
  const leaf = await storage.getBlocks(diff.newLeafCids.toList())
  if (leaf.missing.length > 0) {
    throw new Error(`Missing leaf blocks for firehose CAR: ${leaf.missing}`)
  }
  blocks.addMap(leaf.blocks)

  // Covering proof for each touched key (matches Repo.formatCommit).
  for (const op of ops) {
    const proof = await currData.getCoveringProof(`${op.collection}/${op.rkey}`)
    blocks.addMap(proof)
  }

  // The signed commit block itself (root of the CAR).
  const commitBytes = await storage.getBytes(repo.cid)
  if (!commitBytes) {
    throw new Error('Missing signed commit block for firehose CAR')
  }
  blocks.set(repo.cid, commitBytes)

  return blocks
}

/** Resolve the record CID for an op (create/update → MST leaf cid; delete → null). */
async function recordCidFor(repo: Repo, op: SeqOpInput): Promise<Cid | null> {
  if (op.action === 'delete') return null
  const cid = await repo.data.get(`${op.collection}/${op.rkey}`)
  return (cid as Cid | null) ?? null
}

// ---------------------------------------------------------------------------
// sequenceCommit
// ---------------------------------------------------------------------------

/**
 * Atomically allocate the next firehose seq, build the relay-verifiable
 * `#commit` frame, and persist it (EVT#) plus the head-history row (COMMIT#).
 *
 * Returns the monotonic seq number.
 *
 * @param forceSince - when provided, overrides the `since` field and skips the
 *   global COMMIT#(seq-1) lookup for `prevDataCid`. Pass `null` to emit a
 *   full-resync frame (since=null, prevDataCid=null). Required for a
 *   sub-user's first sequenced commit: the global COMMIT# row preceding this
 *   seq belongs to the apex or another tenant, whose MST CID is not stored
 *   under this tenant's key prefix — loading it would throw MissingBlockError.
 */
export async function sequenceCommit(
  ddb: DynamoDBClient,
  table: string,
  input: SequenceCommitInput,
  // undefined (omit) = automatic cross-tenant guard (degrade to since=null only
  // when the previous global COMMIT# belongs to a different tenant);
  // null = ALWAYS emit a full-resync frame regardless. Both fail safe.
  forceSince?: null,
): Promise<number> {
  const { did, repo, ops, prev } = input

  // 1. Atomic monotonic counter.
  const bump = await ddb.send(
    new UpdateItemCommand({
      TableName: table,
      Key: { pk: { S: SEQ_PK }, sk: { S: SEQ_SK } },
      UpdateExpression: 'ADD #v :one',
      ExpressionAttributeNames: { '#v': 'value' },
      ExpressionAttributeValues: { ':one': { N: '1' } },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  const seq = Number(bump.Attributes?.value?.N)
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`sequenceCommit: invalid seq from counter: ${seq}`)
  }

  // 2. Previous commit (head history) → since + diff base.
  //    When forceSince === null the caller explicitly opts out of the global
  //    COMMIT# lookup (e.g. a sub-user's first firehose event where the
  //    previous global commit belongs to a different tenant).
  //    When the previous COMMIT# row was written by a DIFFERENT tenant (cross-
  //    tenant interleave), using its data/rev as prevDataCid would point
  //    buildDiffBlocks at an MST whose blocks live under a different DID prefix,
  //    causing MissingBlockError and severing the apex firehose. Instead we
  //    treat this case exactly like forceSince=null: emit a full-resync frame
  //    (since=null, prevDataCid=null) which the relay already tolerates.
  let since: string | null
  let prevDataCid: Cid | null
  // Sync v1.1 prevData, tenant chain only. Apex frames omit it (byte-identical).
  let framePrevData: Cid | undefined
  if (forceSince === null) {
    // Full-resync frame: relay treats since=null as "send me everything".
    since = null
    prevDataCid = null
  } else if (prev && did !== APEX_DID) {
    // Tenant chain: diff against THIS repo's previous commit, independent of
    // which tenant happened to be sequenced last (Task 7 root cause).
    since = prev.rev
    prevDataCid = CID.parse(prev.data) as Cid
    framePrevData = prevDataCid
  } else {
    const prevCommit = await readLatestCommitBefore(ddb, table, seq)
    // Cross-tenant guard: if the previous COMMIT# row belongs to a different
    // tenant, fall back to a full-resync frame. Missing `did` on old rows is
    // treated as APEX_DID for backward-compat (apex commits written before this
    // change had no `did` attribute; they continue to chain normally).
    const prevDid = prevCommit?.did ?? APEX_DID
    const isSameTenant = !prevCommit || prevDid === did
    if (isSameTenant) {
      since = prevCommit?.rev ?? null
      prevDataCid = prevCommit?.data ? (CID.parse(prevCommit.data) as Cid) : null
    } else {
      // Cross-tenant safety: at high N-tenant write interleave this emits a
      // full-resync frame on every cross-tenant boundary — acceptable at
      // admin-provisioned scale (see docs/multiuser.md).
      since = null
      prevDataCid = null
    }
  }

  // 3. Diff blocks → CARv1 (root = commit cid).
  const diffBlocks = await buildDiffBlocks(repo, prevDataCid, ops)
  const fullCar = await blocksToCarFile(repo.cid, diffBlocks)

  // 4. ops mapped to firehose shape.
  //    Sync v1.1 (tenant chain only: the frame carries prevData): a verifying
  //    relay inverts each op against prevData, which needs `prev` = the CID
  //    the record had BEFORE this commit for every update/delete. A null prev
  //    there makes the frame un-invertible (rejected / forced resync), i.e.
  //    tenant edits and deletes would silently not reach the AppView. Apex
  //    frames carry no prevData and stay byte-identical (prev: null).
  const prevMst =
    framePrevData ? MST.load((repo as any).storage, framePrevData) : null
  const evtOps: CommitEvtOp[] = []
  for (const op of ops) {
    const path = `${op.collection}/${op.rkey}`
    evtOps.push({
      action: op.action,
      path,
      cid: await recordCidFor(repo, op),
      prev:
        prevMst && op.action !== 'create'
          ? (((await prevMst.get(path)) as Cid | null) ?? null)
          : null,
    })
  }

  // 4b. DynamoDB 400KB item-cap guard: if the diff CAR is too large to inline
  //     (full-resync of a large repo), fall back to a `tooBig` frame carrying
  //     only the commit block. A commit-only CAR keeps the signed commit
  //     verifiable while staying tiny; the relay resyncs via getRepo. Commits
  //     under the cap (all apex commits) keep the full CAR + ops, byte-identical.
  const commitOnly = new BlockMap()
  const commitBytes = diffBlocks.get(repo.cid)
  if (commitBytes) commitOnly.set(repo.cid, commitBytes)
  const commitOnlyCar = await blocksToCarFile(repo.cid, commitOnly)
  const maxInline =
    Number(process.env.SEQ_MAX_INLINE_CAR_BYTES) || DEFAULT_MAX_INLINE_CAR_BYTES
  const { blocks, ops: frameOps, tooBig } = selectFrameBlocks(
    fullCar,
    commitOnlyCar,
    evtOps,
    maxInline,
  )

  // 5. Build the wire frame: header + body, both DAG-CBOR, concatenated.
  const time = new Date().toISOString()
  const header = { op: 1, t: '#commit' }
  const body: CommitEvtBody = {
    seq,
    time,
    repo: did,
    commit: repo.cid,
    rev: repo.commit.rev,
    since,
    blocks,
    ops: frameOps,
    blobs: [],
    rebase: false,
    tooBig,
    ...(framePrevData ? { prevData: framePrevData } : {}),
  }
  const frame = Buffer.concat([cborEncode(header), cborEncode(body)])

  // 6. Persist EVT# (replayable frame) + COMMIT# (head history) atomically.
  const nowSec = Math.floor(Date.now() / 1000)
  const dataCid = repo.commit.data.toString()
  await ddb.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: evtPk(seq) },
              sk: { S: EVT_SK },
              seq: { N: String(seq) },
              frame: { B: new Uint8Array(frame) },
              ttl: { N: String(nowSec + EVT_TTL_SECONDS) },
            },
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: commitPk(seq) },
              sk: { S: COMMIT_SK },
              seq: { N: String(seq) },
              cid: { S: repo.cid.toString() },
              rev: { S: repo.commit.rev },
              data: { S: dataCid },
              ts: { S: time },
              did: { S: did },
            },
          },
        },
      ],
    }),
  )

  return seq
}

/**
 * Look up the COMMIT# row for exactly `seq - 1`.
 *
 * Returns `rev`, `data` (MST root CID string), and `did` (writing tenant DID).
 * `did` may be absent on legacy rows written before the cross-tenant guard was
 * added; callers treat a missing `did` as APEX_DID for backward-compat.
 *
 * NOTE: In the steady-state single-writer path this is always the immediately
 * preceding commit. If a crash occurred between the counter increment and the
 * TransactWrite, a seq gap exists and this returns null, causing `since` to be
 * null (the relay treats it as a full resync rather than a delta). This is an
 * acceptable POC trade-off; a production implementation would do a
 * reverse-range query (seq-ordered GSI or scan) to find the true latest commit.
 */
async function readLatestCommitBefore(
  ddb: DynamoDBClient,
  table: string,
  seq: number,
): Promise<{ rev: string; data: string; did: string | undefined } | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: commitPk(seq - 1) } },
      Limit: 1,
    }),
  )
  const item = res.Items?.[0]
  if (!item) return null
  return {
    rev: item.rev.S as string,
    data: item.data.S as string,
    did: item.did?.S,
  }
}

// ---------------------------------------------------------------------------
// readEventFrame / parseEventFrame
// ---------------------------------------------------------------------------

/** Read the raw stored frame bytes for a given seq. */
export async function readEventFrame(
  ddb: DynamoDBClient,
  table: string,
  seq: number,
): Promise<Uint8Array> {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: table,
      Key: { pk: { S: evtPk(seq) }, sk: { S: EVT_SK } },
    }),
  )
  const raw = res.Item?.frame?.B
  if (!raw) {
    throw new Error(`No event frame stored for seq ${seq}`)
  }
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw)
}

/**
 * Parse a frame back into { header, body }. The frame is two concatenated
 * DAG-CBOR objects (header then body) — exactly `Frame.fromBytes` in
 * @atproto/xrpc-server uses `decodeAll`.
 */
export function parseEventFrame(bytes: Uint8Array): ParsedFrame {
  // decodeAll returns an iterable of decoded items, not an array.
  const items = [...cborDecodeAll(bytes)]
  if (items.length < 2) {
    throw new Error(`Invalid frame: expected 2 CBOR items, got ${items.length}`)
  }
  const header = items[0] as { op: number; t: string }
  const body = items[1] as CommitEvtBody
  return { header, body }
}

// ---------------------------------------------------------------------------
// Frame builders for non-commit frames (DRY — reuse cborEncode, no new dep)
// ---------------------------------------------------------------------------

/**
 * Encode a subscribeRepos `#info` frame (op:1, t:'#info').
 * Used to signal `OutdatedCursor` before replaying from the earliest retained event.
 * Wire: Buffer.concat([encode({op:1,t:'#info'}), encode({name, message?})])
 */
export function encodeInfoFrame(name: string, message?: string): Uint8Array {
  const header = { op: 1, t: '#info' }
  const body: Record<string, unknown> = { name }
  if (message !== undefined) body.message = message
  return new Uint8Array(
    Buffer.concat([
      cborEncode(header as Parameters<typeof cborEncode>[0]),
      cborEncode(body as Parameters<typeof cborEncode>[0]),
    ]),
  )
}

/**
 * Encode a subscribeRepos error frame (op:-1).
 * Used to signal `FutureCursor` (and other stream errors).
 * Wire: Buffer.concat([encode({op:-1}), encode({error, message?})])
 */
export function encodeErrorFrame(error: string, message?: string): Uint8Array {
  const header = { op: -1 }
  const body: Record<string, unknown> = { error }
  if (message !== undefined) body.message = message
  return new Uint8Array(
    Buffer.concat([
      cborEncode(header as Parameters<typeof cborEncode>[0]),
      cborEncode(body as Parameters<typeof cborEncode>[0]),
    ]),
  )
}

/** Zero-padded seq string (16 chars) — exported for use in firehose-ws.ts. */
export { pad16 }

// ---------------------------------------------------------------------------
// verifyEventCommit — the EXACT relay-side cryptographic check
// ---------------------------------------------------------------------------

/**
 * Load the signed commit object out of `body.blocks` (the CAR) and verify its
 * secp256k1 signature against the repo's signing key.
 *
 * This replicates, byte-for-byte, what the relay does:
 *   - indigo  atproto/repo/car.go  `LoadCommitFromCAR`  (root block of CAR)
 *   - indigo  atproto/repo/commit.go `Commit.VerifySignature`
 *               (strip `sig`, re-encode DAG-CBOR, verify)
 *   - @atproto/repo util.js `verifyCommitSig`:
 *               const {sig,...rest}=commit; verifySignature(didKey, encode(rest), sig)
 *
 * Throws if the commit block is missing, the DID mismatches, or the signature
 * is invalid (tampered frame / wrong key).
 */
export async function verifyEventCommit(
  parsed: ParsedFrame,
  did: string,
  signingKeyDid: string,
): Promise<void> {
  const { body } = parsed
  if (body.repo !== did) {
    throw new Error(`Commit repo ${body.repo} != expected ${did}`)
  }

  // Read the CAR; its single root is the commit CID.
  const { roots, blocks } = await readCar(body.blocks)
  const root = roots[0]
  if (!root) {
    throw new Error('Firehose CAR has no root')
  }
  if (root.toString() !== body.commit.toString()) {
    throw new Error(
      `CAR root ${root.toString()} != body.commit ${body.commit.toString()}`,
    )
  }

  const commitBytes = blocks.get(root)
  if (!commitBytes) {
    throw new Error('Signed commit block not present in firehose CAR')
  }

  const [commitDecoded] = [...cborDecodeAll(commitBytes)]
  const commit = commitDecoded as Record<string, unknown> & {
    did: string
    sig: Uint8Array
  }
  if (!commit || !(commit.sig instanceof Uint8Array)) {
    throw new Error('Commit block missing signature')
  }
  if (commit.did !== did) {
    throw new Error(`Commit.did ${commit.did} != expected ${did}`)
  }

  // Strip sig, re-encode DAG-CBOR, verify ES256K — the relay's exact check
  // (mirrors @atproto/repo util.js `verifyCommitSig` / indigo Commit.VerifySignature).
  const { sig, ...unsigned } = commit
  const unsignedBytes = cborEncode(unsigned as Parameters<typeof cborEncode>[0])
  const ok = await verifySignature(signingKeyDid, unsignedBytes, sig, {
    jwtAlg: 'ES256K',
  })
  if (!ok) {
    throw new Error('Commit signature verification failed')
  }
}
