/**
 * DynamoRepoStorage — tenant-aware AT Protocol repo storage over DynamoDB.
 *
 * Key schema is delegated to keyFor()/parseBlockCid() in ./tenant-keys.
 * The apex DID (did:web:serverless.social) keeps the legacy literal keys
 * (ACCOUNT / BLOCK#<cid>) for backward compatibility; every other tenant is
 * isolated under a "<did>#" key prefix.
 *
 * Concurrency note: blocks are written before the root pointer is updated (non-transactional).
 * For a single low-volume writer this is acceptable for the POC; a crash between the two leaves
 * orphaned blocks but never a dangling root pointer. GC of removedCids is deferred — see
 * docs/research/01-atproto-pds.md §7.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { BlockMap, ReadableBlockstore } from '@atproto/repo'
import { RepoStorage } from '@atproto/repo/dist/storage/types.js'
import { CommitData } from '@atproto/repo/dist/types.js'
import { CID } from '@atproto/lex-data'
import { keyFor, parseBlockCid, APEX_DID } from './tenant-keys'

// Cid is the multiformats CID type re-exported from @atproto/lex-data
type Cid = InstanceType<typeof CID>

export class DynamoRepoStorage extends ReadableBlockstore implements RepoStorage {
  private doc: DynamoDBDocumentClient
  private readonly did: string

  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
    did: string,            // no default; callers MUST pass the tenant DID explicitly
  ) {
    super()
    this.did = did
    this.doc = DynamoDBDocumentClient.from(client)
  }

  /** Underlying DynamoDB client — reused by the sequencer (no second client). */
  get ddbClient(): DynamoDBClient {
    return this.client
  }

  /** Backing table name — reused by the sequencer. */
  get tableName(): string {
    return this.table
  }

  // ── Root pointer ─────────────────────────────────────────────────────────────

  async getRoot(): Promise<Cid | null> {
    const { pk, sk } = keyFor(this.did, 'root')
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk, sk } }),
    )
    if (!res.Item?.headCid) return null
    return CID.parse(res.Item.headCid as string) as Cid
  }

  async updateRoot(cid: Cid, rev: string): Promise<void> {
    const { pk, sk } = keyFor(this.did, 'root')
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, headCid: cid.toString(), rev },
      }),
    )
  }

  // ── Block primitives ─────────────────────────────────────────────────────────

  async getBytes(cid: Cid): Promise<Uint8Array | null> {
    const { pk, sk } = keyFor(this.did, 'block', cid.toString())
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk, sk },
      }),
    )
    if (!res.Item?.bytes) return null
    // DDB returns Binary data as Buffer; normalise to Uint8Array
    const raw = res.Item.bytes as Buffer | Uint8Array
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  }

  async has(cid: Cid): Promise<boolean> {
    return (await this.getBytes(cid)) !== null
  }

  async getBlocks(cids: Cid[]): Promise<{ blocks: BlockMap; missing: Cid[] }> {
    const blocks = new BlockMap()
    const missing: Cid[] = []

    if (cids.length === 0) return { blocks, missing }

    // BatchGetItem supports up to 100 keys per request
    const CHUNK = 100
    for (let i = 0; i < cids.length; i += CHUNK) {
      const chunk = cids.slice(i, i + CHUNK)
      const keys = chunk.map((cid) => {
        const { pk, sk } = keyFor(this.did, 'block', cid.toString())
        return { pk, sk }
      })

      const res = await this.doc.send(
        new BatchGetCommand({
          RequestItems: { [this.table]: { Keys: keys } },
        }),
      )

      // TODO(phase-2): BatchGet may return UnprocessedKeys under throttling; retry
      // not implemented. Existing-but-unprocessed CIDs would surface as `missing`.
      // Acceptable under the single low-volume-writer POC assumption.
      const found = new Set<string>()
      for (const item of res.Responses?.[this.table] ?? []) {
        const cidStr = parseBlockCid(this.did, item.pk as string)
        found.add(cidStr)
        const raw = item.bytes as Buffer | Uint8Array
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
        // Re-parse the CID from the string key so we have the proper object
        blocks.set(CID.parse(cidStr) as Cid, bytes)
      }

      for (const cid of chunk) {
        if (!found.has(cid.toString())) {
          missing.push(cid)
        }
      }
    }

    return { blocks, missing }
  }

  async putBlock(cid: Cid, block: Uint8Array, rev: string): Promise<void> {
    const { pk, sk } = keyFor(this.did, 'block', cid.toString())
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, bytes: block, rev },
      }),
    )
  }

  async putMany(blocks: BlockMap, rev: string): Promise<void> {
    const entries: Array<{ cid: Cid; bytes: Uint8Array }> = []
    blocks.forEach((bytes, cid) => entries.push({ cid, bytes }))

    if (entries.length === 0) return

    // BatchWriteItem supports up to 25 requests per call
    const CHUNK = 25
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK)
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.table]: chunk.map(({ cid, bytes }) => {
              const { pk, sk } = keyFor(this.did, 'block', cid.toString())
              return {
                PutRequest: {
                  Item: { pk, sk, bytes, rev },
                },
              }
            }),
          },
        }),
      )
      // TODO(phase-2): BatchWrite may return UnprocessedItems under throttling;
      // retry not implemented (POC single-writer assumption — see docs/research/01 §7).
    }
  }

  // ── Record pointer row ───────────────────────────────────────────────────────
  //
  // Realizes the documented `RECORD#<collection>/<rkey> -> {cid, rev}` layout
  // (pds-table.ts:18). This row was NEVER written before this fix, so the Spec
  // #1 longform render-on-write DDB-stream filter (ESM prefix
  // `RECORD#social.serverless.longform/`) never matched and the renderer never
  // fired. The pointer is a NEW, separate pk namespace — additive only; the
  // sequencer never reads/writes RECORD# rows, so the apex repo + firehose
  // frame bytes are unchanged (proven by the cardinal regression test).
  //
  // `cid` here is the record's DATA cid (the MST leaf value for collection/rkey,
  // the same value getRecord() derives). The DDB stream is NEW_IMAGE; the
  // renderer reads NewImage.cid.S only as a change marker, then RE-READS the
  // record by rkey from the apex repo — so rendered-HTML correctness comes from
  // the rkey re-read, not this cid. We still store the data cid (faithful to the
  // documented shape) and guarantee it is a non-empty string so NewImage.cid.S
  // always exists for the renderer's upsert branch.

  async putRecordPointer(
    collection: string,
    rkey: string,
    cid: string,
    rev: string,
  ): Promise<void> {
    const { pk, sk } = keyFor(this.did, 'record', `${collection}/${rkey}`)
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk, sk, cid, rev },
      }),
    )
  }

  async deleteRecordPointer(collection: string, rkey: string): Promise<void> {
    const { pk, sk } = keyFor(this.did, 'record', `${collection}/${rkey}`)
    await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk, sk },
      }),
    )
  }

  // ── Commit application ───────────────────────────────────────────────────────

  /**
   * applyCommit is the write path called by Repo.applyCommit / Repo.applyWrites.
   * Strategy: write newBlocks first, then update the root pointer.  Non-transactional
   * but safe for single-writer: a crash leaves orphaned blocks, never a dangling root.
   * removedCids GC is deferred (single low-volume repo — see docs/research/01-atproto-pds.md §7).
   */
  async applyCommit(commit: CommitData): Promise<void> {
    await this.putMany(commit.newBlocks, commit.rev)
    await this.updateRoot(commit.cid, commit.rev)
  }
}
