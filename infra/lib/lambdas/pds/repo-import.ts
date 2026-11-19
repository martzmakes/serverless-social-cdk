/**
 * repo-import.ts — INTEGRITY BOUNDARY for untrusted imported repo data.
 *
 * When migrating an account (spec #5 account-migration), the source PDS
 * exports the full repo as a CARv1 via `com.atproto.sync.getRepo`. That CAR
 * is UNTRUSTED input: it is fetched over the network from a server we do not
 * control, on behalf of a DID we are about to take over. Before a single
 * block is persisted into our storage we MUST cryptographically prove the
 * exported repo's head commit was signed by the migrating DID's signing key.
 *
 * This is the exact same check a Bluesky relay performs and the exact same
 * check `sequencer.ts` `verifyEventCommit` performs on outbound firehose
 * frames — same primitives, reused, no new crypto/cbor dependency:
 *
 *   - CAR parse:      `@atproto/repo` `readCar`            (same import as sequencer.ts)
 *   - commit decode:  `@atproto/lex-cbor` `decodeAll`      (DAG-CBOR, as sequencer.ts)
 *   - sig reconstruct:`@atproto/lex-cbor` `encode`         (strip `sig`, re-encode)
 *   - verify:         `@atproto/crypto` `verifySignature`  (ES256K / secp256k1)
 *
 * Reference (mirrors what relays do on the receiving side):
 *   - indigo  atproto/repo/car.go  `LoadCommitFromCAR`  (root block of CAR)
 *   - indigo  atproto/repo/commit.go `Commit.VerifySignature`
 *   - @atproto/repo util.js `verifyCommitSig`:
 *       const {sig,...rest}=commit; verifySignature(didKey, encode(rest), sig)
 *
 * FAIL-CLOSED CONTRACT: every parse / decode / verify error path THROWS.
 * This function never returns a partial result. If it returns, the head
 * commit of the returned CAR was provably signed by `expectedSigningDidKey`.
 *
 * Pure: no AWS, no storage, no network. Caller persists blocks ONLY after
 * this resolves.
 */

import { readCar, Repo, WriteOpAction, parseDataKey } from '@atproto/repo'
import type { RepoStorage } from '@atproto/repo/dist/storage/types.js'
import { encode as cborEncode, decodeAll as cborDecodeAll } from '@atproto/lex-cbor'
import { verifySignature } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import type { NsidString } from '@atproto/syntax'
import type { LexMap } from '@atproto/lex-data'
import { CID } from '@atproto/lex-data'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { sequenceCommit, type SeqOpInput } from './sequencer'

type Cid = InstanceType<typeof CID>

/**
 * The decoded, signature-verified head commit of an imported repo.
 *
 * Field names are the real @atproto repo commit-block fields (DAG-CBOR map):
 *   did, version, data (MST root CID), rev, prev (nullable), sig.
 * `data`/`prev` are kept as decoded (CID instances) — callers that need the
 * MST root walk `commit.data`.
 */
export interface VerifiedCommit {
  did: string
  data: unknown
  rev: string
  sig: Uint8Array
  version?: number
  prev?: unknown
  [k: string]: unknown
}

export interface ParsedRepo {
  /** CARv1 root CID = the signed head-commit CID. */
  root: Cid
  /** Every block carried in the CAR (commit + MST + record leaves). */
  blocks: Awaited<ReturnType<typeof readCar>>['blocks']
  /** The decoded head commit, signature already verified. */
  commit: VerifiedCommit
}

/**
 * Parse an exported repo CARv1 and verify its head commit's signature against
 * the migrating DID's signing key BEFORE any block is persisted.
 *
 * @param carBytes              raw bytes from `com.atproto.sync.getRepo`
 * @param expectedSigningDidKey the migrating DID's signing key, `did:key:z…`
 *                              (the `#atproto` verificationMethod, see
 *                              identity.ts — `did:key:` + publicKeyMultibase)
 * @returns the CAR root, every block, and the verified head commit
 * @throws  on ANY failure: unparseable/empty CAR, missing/extra roots,
 *          missing commit block, malformed commit, missing/invalid signature,
 *          or signature that does not verify against `expectedSigningDidKey`.
 */
export async function parseAndVerifyCar(
  carBytes: Uint8Array,
  expectedSigningDidKey: string,
): Promise<ParsedRepo> {
  if (!(carBytes instanceof Uint8Array) || carBytes.length === 0) {
    throw new Error('Repo import: empty CAR input')
  }
  if (typeof expectedSigningDidKey !== 'string' || !expectedSigningDidKey.startsWith('did:key:')) {
    throw new Error(`Repo import: invalid signing key (expected did:key): ${expectedSigningDidKey}`)
  }

  // 1. Parse the CARv1. readCar throws on truncated / garbage bytes.
  //    (same import + primitive as sequencer.ts verifyEventCommit)
  let roots: Cid[]
  let blocks: ParsedRepo['blocks']
  try {
    const parsed = await readCar(carBytes)
    roots = parsed.roots as Cid[]
    blocks = parsed.blocks
  } catch (err) {
    throw new Error(
      `Repo import: failed to parse CAR — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!roots || roots.length === 0) {
    throw new Error('Repo import: CAR has no root (no head commit to verify)')
  }
  const root = roots[0]
  if (!root) {
    throw new Error('Repo import: CAR root is undefined')
  }

  // 2. Resolve the root block (the signed head commit) and DAG-CBOR-decode it.
  const commitBytes = blocks.get(root)
  if (!commitBytes) {
    throw new Error('Repo import: signed head-commit block not present in CAR')
  }
  let commit: VerifiedCommit
  try {
    const decoded = [...cborDecodeAll(commitBytes)]
    if (decoded.length === 0) {
      throw new Error('empty commit block')
    }
    commit = decoded[0] as VerifiedCommit
  } catch (err) {
    throw new Error(
      `Repo import: failed to decode head commit — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!commit || typeof commit !== 'object') {
    throw new Error('Repo import: head commit malformed (not a map)')
  }
  if (typeof commit.did !== 'string' || commit.did.length === 0) {
    throw new Error('Repo import: head commit missing `did`')
  }
  if (typeof commit.rev !== 'string' || commit.rev.length === 0) {
    throw new Error('Repo import: head commit missing `rev`')
  }
  if (!(commit.sig instanceof Uint8Array) || commit.sig.length === 0) {
    throw new Error('Repo import: head commit missing signature (`sig`)')
  }

  // 3. Reconstruct the UNSIGNED commit bytes and verify the signature.
  //    Strip `sig`, DAG-CBOR re-encode the rest, verify ES256K against the
  //    expected signing key — byte-for-byte the relay's / @atproto's check
  //    (mirrors sequencer.ts verifyEventCommit & @atproto/repo verifyCommitSig).
  const { sig, ...unsigned } = commit
  let ok: boolean
  try {
    const unsignedBytes = cborEncode(unsigned as Parameters<typeof cborEncode>[0])
    ok = await verifySignature(expectedSigningDidKey, unsignedBytes, sig, {
      jwtAlg: 'ES256K',
    })
  } catch (err) {
    // A malformed expected key, an unsupported curve, etc. — fail closed.
    throw new Error(
      `Repo import: head-commit signature verification errored — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!ok) {
    throw new Error(
      `Repo import: head-commit signature verification FAILED for ${commit.did} ` +
        `against ${expectedSigningDidKey} (untrusted/forged CAR rejected)`,
    )
  }

  // 4. Verified. Safe for the caller to persist.
  return { root, blocks, commit }
}

// ---------------------------------------------------------------------------
// importRepoBlocks — persist a verified CAR into the migrating DID's keyspace
// ---------------------------------------------------------------------------

/**
 * Persist every block of a signature-verified `ParsedRepo` into storage and
 * point the repo root at the imported head commit.
 *
 * CONTRACT: `storage` is already DID-scoped — the caller constructs
 * `new DynamoRepoStorage(ddb, table, migratedDid)`, so `keyFor()` automatically
 * prefixes every block/root key with `<migratedDid>#…`. For a sub-user this is
 * `did:plc:…#BLOCK#<cid>` / `did:plc:…#ACCOUNT`; the apex literal keys
 * (`ACCOUNT` / `BLOCK#<cid>`) are NEVER written by an import of a sub-user DID.
 * Do NOT special-case the DID here — that isolation is the storage seam's job.
 *
 * Ordering mirrors `DynamoRepoStorage.applyCommit`: write all blocks first,
 * THEN the root pointer, so a crash mid-import leaves orphaned blocks but never
 * a root that points at an absent commit.
 *
 * The CAR is already proven (head commit signed by the migrating DID) by
 * `parseAndVerifyCar`; this function is the persist half of that pair.
 *
 * @param storage  a DID-scoped RepoStorage (DynamoRepoStorage for the migrated DID)
 * @param parsed   the verified result of `parseAndVerifyCar`
 */
export async function importRepoBlocks(
  storage: RepoStorage,
  parsed: ParsedRepo,
): Promise<void> {
  const rev = parsed.commit.rev
  const writes: Array<Promise<void>> = []
  parsed.blocks.forEach((bytes, cid) => {
    writes.push(storage.putBlock(cid, bytes, rev))
  })
  await Promise.all(writes)
  await storage.updateRoot(parsed.root, rev)
}

// ---------------------------------------------------------------------------
// freshPostImportCommit — first sequenced commit after an account migration
// ---------------------------------------------------------------------------

const ACTOR_PROFILE = 'app.bsky.actor.profile'
const PROFILE_RKEY = 'self'

/**
 * THE RELAY FEDERATION TRIGGER for a migrated repo. `importRepoBlocks` writes
 * the imported blocks into storage but produces NO firehose event, so the relay
 * stays unaware of the migrated account. The relay first sees the account when
 * this `#commit` frame appears in the `subscribeRepos` stream — that is the
 * entire reason this function exists and must be called after import. The
 * `app.bsky.actor.profile` put is chosen only because it is the simplest
 * lexicon type that yields a valid diff CAR + commit block signed by the new
 * key; re-putting the existing profile leaves the account's visible record
 * state byte-identical (the only observable effect is the new rev + signing
 * key). A bare `sequenceCommit` without an `applyWrites` would NOT work — the
 * relay requires a real signed commit block + diff.
 *
 * Loads the just-imported repo, applies a single no-op
 * `app.bsky.actor.profile` put (re-put the existing profile record if one is
 * present, else a minimal `{$type:'app.bsky.actor.profile'}`), signs the new
 * commit with the migrated DID's NEW signing key, and sequences it through the
 * SAME mechanism `repo-write.ts::sequenceAfterWrite` uses
 * (`sequenceCommit(ddb, table, { did, repo, ops })`).
 *
 * `did` is passed straight through to `sequenceCommit` so the firehose
 * `#commit` event and the `COMMIT#`/`EVT#` rows are stamped with the migrated
 * DID — NOT the apex. `forceSince=null` is passed explicitly: this is the
 * account-migration `--federate` path, where this is the migrated repo's FIRST
 * sequenced event on our PDS and the immediately-preceding global `COMMIT#`
 * belongs to the apex (or another tenant). A full-resync frame
 * (`since=null`, `prevDataCid=null`) is exactly what the relay expects for a
 * repo it has not seen from us before, and it cannot point `buildDiffBlocks`
 * at a cross-tenant MST. The returned commit therefore satisfies the Spec #3
 * invariant `body.repo === commit.did === did`.
 *
 * @param storage         DID-scoped storage holding the just-imported repo
 * @param signingKeypair  the migrated DID's NEW signing key (minted by Task 3)
 * @param did             the migrated DID — stamped into the firehose frame
 * @param ddb             DynamoDB client (sequencer reuses it; no second client)
 * @param repoTable       backing repo/firehose table name
 */
export async function freshPostImportCommit(
  storage: RepoStorage,
  signingKeypair: Keypair,
  did: string,
  ddb: DynamoDBClient,
  repoTable: string,
): Promise<{ uri?: string; commit: { cid: string; rev: string } }> {
  const repo = await Repo.load(storage)

  // Re-stamp the repo identity to the migrated DID.
  //
  // The imported CAR's head commit carries the SOURCE PDS's commit.did (for the
  // apex export fixture that is `did:web:serverless.social`). Account migration
  // re-homes the account under our PDS: the new head commit must self-identify
  // as the migrated DID and be signed by its NEW signing key. `@atproto/repo`
  // `formatCommit` signs a FRESH commit `{ did: this.did, version:3, rev, prev,
  // data }` with the provided keypair — `this.did` is `this.commit.did`, so
  // rebinding it here makes the next commit block carry the migrated DID. The
  // MST (`data`) and every record/leaf block are byte-unchanged, so they all
  // still resolve out of storage; only the signed commit block is re-minted.
  // This is the exact effect of an atproto migration resign + first write.
  //
  // MIGRATION RESIGN — DO NOT REMOVE OR WEAKEN THIS LINE.
  // If this rebind is dropped (or the spread changed so `did` is not
  // overwritten), the re-minted commit block keeps the SOURCE PDS's DID, the
  // sequenced firehose frame then has body.repo !== commit.did, and a conformant
  // relay's verifyEventCommit rejects it — silently dropping EVERY subsequent
  // frame for this account (this exact body.repo≠commit.did invariant was a
  // Critical caught in Spec #3 review / `718d02c`). There is no compile-time
  // signal; only the live-proof gate (Spec #5 T8) would catch a regression here.
  repo.commit = { ...repo.commit, did }

  // Re-put the existing profile if present (true no-op), else seed a minimal one.
  const existing = await repo.getRecord(ACTOR_PROFILE, PROFILE_RKEY)
  const record =
    existing !== null
      ? (existing as LexMap)
      : ({ $type: ACTOR_PROFILE } as unknown as LexMap)
  // Existing → Update (no MST-shape change beyond re-encoding); absent → Create.
  const action =
    existing !== null ? WriteOpAction.Update : WriteOpAction.Create

  const next = await repo.applyWrites(
    [
      {
        action,
        collection: ACTOR_PROFILE as NsidString,
        rkey: PROFILE_RKEY,
        record,
      },
    ],
    signingKeypair,
  )

  // ── ADVERTISE EVERY IMPORTED RECORD AS A FIREHOSE OP (the Spec #5 fix) ──────
  //
  // ROOT CAUSE this fixes: previously this passed `ops: [<profile op only>]`.
  // The public Bluesky AppView's record indexer is OP-DRIVEN — it indexes
  // exactly the records named in the firehose `#commit` `ops[]`. The imported
  // repo's other records (e.g. the seeded `app.bsky.feed.post`) ARE persisted
  // and served by getRepo (HTTP 200), but were NEVER advertised as ops, so a
  // migrated account showed postsCount:0 forever even though its repo was
  // fully present and the relay ingested the commit head.
  //
  // FIX (design A — enumerate every record in the loaded Repo MST and emit a
  // `create` op for each): walk `next.data` (the post-write MST, which contains
  // EVERY imported record + the re-put profile) using the SAME primitive
  // `repo-read.ts::describeRepo` already uses (`MST.list()` + `parseDataKey`),
  // and build one full-resync `#commit` whose `ops[]` is a create for every
  // {collection,rkey}. `forceSince=null` makes `buildDiffBlocks` diff the full
  // MST against null → the CAR carries every record leaf + all MST nodes, so
  // the relay/AppView can resolve every op's record. This is exactly what a
  // real PDS emits on account import/activation: the whole repo advertised in
  // one resync frame. Composes cleanly with `sequenceCommit` — its `ops[]` is
  // already a `SeqOpInput[]` it iterates over (covering proof + evtOp per op),
  // so N ops in ONE commit needs no sequencer change.
  //
  // The profile op is included too: it is the `app.bsky.actor.profile`/`self`
  // leaf in the same MST walk, so it is advertised like every other record
  // (its action is the same `create` — the AppView indexes a create as
  // "record present", which is the goal; the re-put left the profile value
  // byte-identical so this is observationally a no-op for that record).
  //
  // Idempotent / safe on re-run: the walk reflects whatever the MST currently
  // holds; re-running re-advertises the same record set as creates (a relay
  // treats a create for an already-present record on a full-resync frame as
  // the expected resync, not a conflict).
  const allLeaves = await next.data.list()
  const ops: SeqOpInput[] = allLeaves.map((leaf) => {
    const { collection, rkey } = parseDataKey(leaf.key)
    return { action: 'create' as const, collection, rkey }
  })
  if (ops.length === 0) {
    // Defensive: a repo with zero MST leaves cannot happen after the profile
    // put above (applyWrites always leaves >=1 leaf). Fail closed rather than
    // sequence an empty-ops frame the AppView would index as nothing.
    throw new Error(
      'freshPostImportCommit: imported repo MST has no records after profile put — refusing to sequence an empty-ops commit',
    )
  }

  // Same sequencing call shape as repo-write.ts::sequenceAfterWrite, with the
  // explicit cross-tenant full-resync (`forceSince = null`) for a migrated
  // repo's first event. `did` is stamped onto COMMIT#/EVT#/body.repo. `ops`
  // now advertises ALL imported records, not just the profile.
  await sequenceCommit(
    ddb,
    repoTable,
    {
      did,
      repo: next,
      ops,
    },
    null,
  )

  return {
    uri: `at://${did}/${ACTOR_PROFILE}/${PROFILE_RKEY}`,
    commit: { cid: next.cid.toString(), rev: next.commit.rev },
  }
}
