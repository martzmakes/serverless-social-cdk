/**
 * repo-write.ts — signed write operations over the AT Protocol repo.
 *
 * Each function loads the current repo state from storage, applies the
 * requested write (signed with the provided keypair), and persists the new
 * commit back through the storage seam (DynamoRepoStorage.applyCommit).
 *
 * Supported operations:
 *   createRecord — insert a new record, auto-generating an rkey via TID if not provided
 *   putRecord    — upsert (create or update) a record at a specific rkey
 *   deleteRecord — remove a record from the repo
 *   getRecord    — read a record value by collection + rkey (no write, no keypair needed)
 */

import { Repo, WriteOpAction } from '@atproto/repo'
import type { RepoStorage } from '@atproto/repo/dist/storage/types.js'
import { TID } from '@atproto/common-web'
import type { Keypair } from '@atproto/crypto'
import type { NsidString } from '@atproto/syntax'
import type { LexMap } from '@atproto/lex-data'
import { loadRepoOrThrow } from './repo-root'
import { DynamoRepoStorage } from './storage'
import { sequenceCommit, type SeqOpAction } from './sequencer'
import { normalizeCidsToIpldJson } from './lex-json'

/**
 * Append a relay-verifiable #commit event to the firehose log after a write.
 *
 * Sequencing must NOT corrupt the repo: the new blocks + root were already
 * persisted inside `applyWrites` → `storage.applyCommit`. If sequencing fails
 * we surface the error. Note: a `sequenceCommit` throw means no EVT# row is
 * written for that commit — the relay cannot backfill what was never persisted.
 * The cross-tenant guard in `sequenceCommit` prevents the most likely throw
 * (MissingBlockError after a sub-user interleave). Best-effort, never rolls back.
 *
 * `did` is the repo/tenant DID being written (resolved from the authenticated
 * principal by the handler). It is stamped into the firehose `#commit` event's
 * `body.repo` field so a sub-user's federated commit self-identifies as that
 * sub-user — NOT the apex. For the apex this is exactly `APEX_DID`
 * (= `did:web:serverless.social`), so the emitted frame is byte-identical to
 * the legacy single-tenant path.
 */
async function sequenceAfterWrite(
  storage: RepoStorage,
  did: string,
  next: Repo,
  action: SeqOpAction,
  collection: string,
  rkey: string,
  prev: Repo,
): Promise<void> {
  if (!(storage instanceof DynamoRepoStorage)) {
    // Non-DDB storage (unit fixtures) — nothing to sequence against.
    return
  }
  await sequenceCommit(storage.ddbClient, storage.tableName, {
    did,
    repo: next,
    ops: [{ action, collection, rkey }],
    // The repo's own previous commit: lets a tenant frame be a small delta even
    // when another tenant was sequenced in between (ignored for the apex).
    prev: { rev: prev.commit.rev, data: prev.commit.data.toString() },
  })
}

/**
 * Write the `RECORD#<collection>/<rkey> -> {cid, rev}` pointer row after a
 * create/update.
 *
 * ORDERING: this is called AFTER `sequenceAfterWrite` — so the new blocks +
 * root + the relay-verifiable firehose `#commit` frame are durable BEFORE the
 * pointer exists. A crash must never leave a pointer to an uncommitted /
 * un-sequenced record; the pointer is the last, additive step. This realizes
 * the documented key layout the Spec #1 longform render-on-write stream filter
 * depends on (the row was never written → the renderer never fired).
 *
 * CID CHOICE: we store the record's DATA cid (the MST leaf value for
 * `collection/rkey`, identical to what `getRecord` derives). The DDB stream is
 * NEW_IMAGE and the renderer reads `NewImage.cid.S` only as a change marker
 * before RE-READING the record by rkey — so rendered-HTML correctness comes
 * from the rkey re-read, not this cid. We still prefer the data cid (faithful
 * to the documented `{cid, rev}` shape); if the MST walk somehow yields no leaf
 * we fall back to the signed commit cid so the attribute is always a non-empty
 * string and `NewImage.cid.S` always exists for the renderer's upsert branch.
 *
 * Guarded on `DynamoRepoStorage` so non-DDB unit fixtures are unaffected
 * (mirrors `sequenceAfterWrite`).
 *
 * BEST-EFFORT CONTRACT: this runs AFTER the commit + firehose frame are
 * durable. The `RECORD#<collection>/<rkey>` pointer only drives the Spec #1
 * longform render-on-write stream; a failed pointer write must NOT fail or
 * roll back an already-committed, already-federated repo write (mirrors the
 * `sequenceAfterWrite` contract). The renderer self-heals on the next write
 * to that record or a longform-backfill run. Errors are swallowed and logged
 * to CloudWatch for observability.
 */
async function writeRecordPointerAfterSeq(
  storage: RepoStorage,
  next: Repo,
  collection: string,
  rkey: string,
): Promise<void> {
  if (!(storage instanceof DynamoRepoStorage)) return
  try {
    const leafCid = await next.data.get(`${collection}/${rkey}`)
    const cid = leafCid !== null ? leafCid.toString() : next.cid.toString()
    await storage.putRecordPointer(collection, rkey, cid, next.commit.rev)
  } catch (err) {
    // Best-effort: the commit + firehose are already durable. Do not 500 a
    // successful, already-federated publish over an additive pointer blip —
    // the renderer self-heals on the next write or a longform-backfill.
    console.error(
      `[repo-write] best-effort RECORD pointer write failed (swallowed); ` +
        `did=${next.did} collection=${collection} rkey=${rkey} op=put`,
      err,
    )
  }
}

/**
 * Remove the `RECORD#<collection>/<rkey>` pointer row after a delete.
 * Ordered AFTER `sequenceAfterWrite` (the firehose REMOVE/delete frame is
 * sequenced first); the pointer removal drives the renderer's REMOVE branch
 * (the no-410-on-delete half of the original defect). Guarded like above.
 *
 * BEST-EFFORT CONTRACT: this runs AFTER the commit + firehose REMOVE frame
 * are durable. The `RECORD#<collection>/<rkey>` pointer only drives the
 * Spec #1 longform render-on-write stream; a failed pointer delete must NOT
 * fail or roll back an already-committed, already-federated repo write
 * (mirrors the `sequenceAfterWrite` contract). The renderer self-heals on
 * the next write to that record or a longform-backfill run. Errors are
 * swallowed and logged to CloudWatch for observability.
 */
async function deleteRecordPointerAfterSeq(
  storage: RepoStorage,
  did: string,
  collection: string,
  rkey: string,
): Promise<void> {
  if (!(storage instanceof DynamoRepoStorage)) return
  try {
    await storage.deleteRecordPointer(collection, rkey)
  } catch (err) {
    // Best-effort: the commit + firehose REMOVE frame are already durable.
    // Do not 500 a successful, already-federated delete over an additive
    // pointer blip — the renderer self-heals on the next write or a
    // longform-backfill.
    console.error(
      `[repo-write] best-effort RECORD pointer delete failed (swallowed); ` +
        `did=${did} collection=${collection} rkey=${rkey} op=delete`,
      err,
    )
  }
}

// ---------------------------------------------------------------------------
// ensureRepoRoot — init-if-absent for a brand-new (rootless) tenant repo
// ---------------------------------------------------------------------------

/**
 * Guarantee the repo backing `storage` has a root commit before a write.
 *
 * ROOT CAUSE this addresses: `Repo.load(storage)` (used by createRecord /
 * putRecord / deleteRecord below) calls `storage.getRoot()` and throws
 * `'No cid provided and none in storage'` (@atproto/repo repo.js:100-104) when
 * the tenant repo has never had a root commit established. The canonical way a
 * brand-new account first gets a writable repo in THIS system is
 * `Repo.create(storage, did, keypair, …)` — the self-serve provisioning path's
 * `initRepo` (scripts/provision-subuser.ts:366 `Repo.create(...)`, the port
 * wired at lib/lambdas/pds/provision.ts:125) and every repo-write unit test
 * (test/pds/repo-write.test.ts) seed the root exactly this way. We reuse that
 * SAME canonical primitive here — NOT a bespoke commit reimplementation.
 *
 * BEHAVIOUR CONTRACT (load-bearing — keeps the real-account path unchanged):
 *   - root EXISTS  → `storage.getRoot()` returns a non-null CID → RETURN
 *     IMMEDIATELY. NO Repo.create, NO write, NO commit, NO firehose event.
 *     This is the ONLY branch the real `did:plc:a62…` backfill ever takes
 *     (its repo root was established by the Spec #5 A5 CAR import →
 *     `repo-import.ts::importRepoBlocks` → `storage.updateRoot`), so the
 *     existing-repo / real-account write path is provably untouched.
 *   - root ABSENT  → seed an EMPTY repo root (`initialWrites = []`) signed
 *     with the tenant's own signing keypair (the SAME keypair the subsequent
 *     write uses). An empty root is sufficient: `Repo.load` only needs a root
 *     commit to exist; the backfill then adds records onto it. (The
 *     provisioning path additionally seeds an `app.bsky.actor.profile`/self
 *     record, but that is a profile-presence concern orthogonal to making the
 *     repo loadable — an empty root faithfully represents "a freshly-rooted
 *     repo with no records yet", which is exactly what backfill expects.)
 *
 * Returns true iff it created the initial root (caller may log); false = no-op.
 */
export async function ensureRepoRoot(
  storage: RepoStorage,
  did: string,
  keypair: Keypair,
): Promise<boolean> {
  const root = await (storage as { getRoot(): Promise<unknown> }).getRoot()
  if (root) {
    // Root already established — real-account path. Strict no-op.
    return false
  }
  // Brand-new rootless repo — seed an empty root via the canonical primitive
  // (identical call shape to provision-subuser.ts initRepo / repo-write tests).
  await Repo.create(storage, did, keypair, [])
  return true
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateRecordInput = {
  collection: string
  rkey?: string
  record: Record<string, unknown>
}

export type PutRecordInput = {
  collection: string
  rkey: string
  record: Record<string, unknown>
}

export type DeleteRecordInput = {
  collection: string
  rkey: string
}

export type GetRecordInput = {
  collection: string
  rkey: string
}

export type WriteResult = {
  uri: string
  commit: { cid: string; rev: string }
  /** The record's own CID (com.atproto.repo.createRecord / putRecord return it next to `uri`). */
  cid?: string
}

export type GetRecordResult = {
  uri: string
  cid: string | null
  value: unknown
}

// ---------------------------------------------------------------------------
// createRecord
// ---------------------------------------------------------------------------

/**
 * Insert a new record into the repo.
 * Generates a time-ordered rkey via TID.nextStr() when not provided by the caller.
 */
export async function createRecord(
  storage: RepoStorage,
  keypair: Keypair,
  did: string,
  input: CreateRecordInput,
): Promise<WriteResult> {
  const rkey = input.rkey ?? TID.nextStr()
  // Init-if-absent: if this tenant repo has no root yet (a brand-new repo that
  // never had Repo.create / a CAR import), seed an empty root with the SAME
  // signing keypair before loading. NO-OP when a root exists — the real
  // `did:plc:a62…` backfill target already has a root (Spec #5 A5 import), so
  // the real-account write path takes the strict no-op branch and is unchanged.
  await ensureRepoRoot(storage, did, keypair)
  const repo = await Repo.load(storage)
  const next = await repo.applyWrites(
    [
      {
        action: WriteOpAction.Create,
        collection: input.collection as NsidString,
        rkey,
        record: input.record as LexMap,
      },
    ],
    keypair,
  )
  await sequenceAfterWrite(storage, did, next, 'create', input.collection, rkey, repo)
  await writeRecordPointerAfterSeq(storage, next, input.collection, rkey)
  return {
    uri: `at://${did}/${input.collection}/${rkey}`,
    cid: (await next.data.get(`${input.collection}/${rkey}`))?.toString(),
    commit: { cid: next.cid.toString(), rev: next.commit.rev },
  }
}

// ---------------------------------------------------------------------------
// putRecord
// ---------------------------------------------------------------------------

/**
 * Upsert a record at the given rkey.
 *
 * Strategy: attempt Update first; if the record does not exist (the MST has no
 * entry for that key) the Update will fail with an error — catch it and retry
 * with Create.  This keeps the caller API clean: callers don't need to know
 * whether the record already exists.
 */
export async function putRecord(
  storage: RepoStorage,
  keypair: Keypair,
  did: string,
  input: PutRecordInput,
): Promise<WriteResult> {
  const repo = await Repo.load(storage)

  // Single-tenant PDS: exactly one writer, no concurrent putRecord — the check-then-write gap is safe by deployment assumption (see docs/research/01 §6).
  // Check whether the record already exists so we can pick the right action.
  const existing = await repo.getRecord(input.collection, input.rkey)
  const action = existing !== null ? WriteOpAction.Update : WriteOpAction.Create

  const next = await repo.applyWrites(
    [
      {
        action,
        collection: input.collection as NsidString,
        rkey: input.rkey,
        record: input.record as LexMap,
      },
    ],
    keypair,
  )
  await sequenceAfterWrite(
    storage,
    did,
    next,
    action === WriteOpAction.Update ? 'update' : 'create',
    input.collection,
    input.rkey,
    repo,
  )
  await writeRecordPointerAfterSeq(storage, next, input.collection, input.rkey)
  return {
    uri: `at://${did}/${input.collection}/${input.rkey}`,
    cid: (await next.data.get(`${input.collection}/${input.rkey}`))?.toString(),
    commit: { cid: next.cid.toString(), rev: next.commit.rev },
  }
}

// ---------------------------------------------------------------------------
// deleteRecord
// ---------------------------------------------------------------------------

/**
 * Remove a record from the repo.
 * Throws with xrpcError='RecordNotFound' if the record does not exist.
 */
export async function deleteRecord(
  storage: RepoStorage,
  keypair: Keypair,
  did: string,
  input: DeleteRecordInput,
): Promise<{ commit: { cid: string; rev: string } }> {
  const repo = await Repo.load(storage)

  // Guard: ensure the record exists before attempting delete.
  const existing = await repo.getRecord(input.collection, input.rkey)
  if (existing === null) {
    const err = new Error(`Record not found: ${input.collection}/${input.rkey}`)
    ;(err as any).xrpcError = 'RecordNotFound'
    throw err
  }

  const next = await repo.applyWrites(
    [
      {
        action: WriteOpAction.Delete,
        collection: input.collection as NsidString,
        rkey: input.rkey,
      },
    ],
    keypair,
  )
  await sequenceAfterWrite(storage, did, next, 'delete', input.collection, input.rkey, repo)
  await deleteRecordPointerAfterSeq(storage, did, input.collection, input.rkey)
  return {
    commit: { cid: next.cid.toString(), rev: next.commit.rev },
  }
}

// ---------------------------------------------------------------------------
// getRecord
// ---------------------------------------------------------------------------

/**
 * Read a record from the repo by collection + rkey.
 * Throws with xrpcError='RepoNotFound' when the repo does not exist yet.
 * Throws with xrpcError='RecordNotFound' when the repo exists but the record is absent.
 *
 * The CID is derived by walking the MST for the exact leaf entry.  If the MST
 * walk returns null (record absent) we throw before returning.
 */
export async function getRecord(
  storage: RepoStorage,
  did: string,
  input: GetRecordInput,
): Promise<GetRecordResult> {
  const { repo } = await loadRepoOrThrow(storage)
  const rawValue = await repo.getRecord(input.collection, input.rkey)

  if (rawValue === null) {
    const err = new Error(`Record not found: ${input.collection}/${input.rkey}`)
    ;(err as any).xrpcError = 'RecordNotFound'
    throw err
  }

  // Derive the CID from the MST.  The MST key format is "collection/rkey".
  // repo.data.get() returns the CID stored at that leaf, or null.
  const mstKey = `${input.collection}/${input.rkey}`
  const cid = await repo.data.get(mstKey)
  const cidStr = cid !== null ? cid.toString() : null

  return {
    uri: `at://${did}/${input.collection}/${input.rkey}`,
    cid: cidStr,
    value: normalizeCidsToIpldJson(rawValue),
  }
}
