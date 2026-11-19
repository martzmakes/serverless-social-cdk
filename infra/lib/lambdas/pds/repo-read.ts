/**
 * repo-read.ts — AT Protocol repo read surface (com.atproto.repo.*).
 *
 * Implements:
 *   listRecords      → com.atproto.repo.listRecords
 *   getRecordByRkey  → single-record point read (MST get, no scan)
 *   describeRepo     → com.atproto.repo.describeRepo
 *
 * listRecords follows the lexicon: default order is reverse-chronological
 * (rkey DESCENDING); `reverse=true` flips to ascending. `limit` defaults to 50
 * and is clamped to 1..100. `cursor` is the rkey of the last record of the
 * previous page; the next page continues strictly after it in the chosen
 * direction. A cursor is returned only when more records remain.
 *
 * Only MST node blocks are read to enumerate keys; record value blocks are read
 * solely for the returned page.
 *
 * API symbols used from @atproto/repo@0.9.1:
 *   - `repo.data.listWithPrefix(prefix)` → {key,value: Cid}[] (MST order, keys only)
 *   - `repo.data.get(key)`               → Cid | null
 *   - `repo.storage.readRecord(cid)`     → LexMap
 */

import { parseDataKey } from '@atproto/repo'
import type { RepoStorage } from '@atproto/repo/dist/storage/types.js'
import { loadRepoOrThrow } from './repo-root'
import { normalizeCidsToIpldJson } from './lex-json'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ListRecordsInput = {
  collection: string
  limit?: number
  /** rkey of the last record of the previous page. */
  cursor?: string
  /** true = oldest-first (ascending rkey). Default newest-first. */
  reverse?: boolean
}

export type RecordEntry = {
  uri: string
  cid: string
  value: unknown
}

export type ListRecordsOutput = {
  records: RecordEntry[]
  cursor?: string // undefined = end of list
}

export type DescribeRepoOutput = {
  did: string
  handle: string
  collections: string[]
  handleIsCorrect: boolean
}

// ---------------------------------------------------------------------------
// listRecords
// ---------------------------------------------------------------------------

export const LIST_RECORDS_DEFAULT_LIMIT = 50
export const LIST_RECORDS_MAX_LIMIT = 100

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return LIST_RECORDS_DEFAULT_LIMIT
  }
  return Math.min(LIST_RECORDS_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

/**
 * Enumerate records in a collection, per the com.atproto.repo.listRecords
 * lexicon (newest-first by default, `reverse` flips, cursor paging).
 *
 * Throws with xrpcError='RepoNotFound' if storage has no root.
 */
export async function listRecords(
  storage: RepoStorage,
  did: string,
  input: ListRecordsInput,
): Promise<ListRecordsOutput> {
  const { repo } = await loadRepoOrThrow(storage)
  const limit = clampLimit(input.limit)
  const prefix = input.collection + '/'

  // Keys + CIDs only (MST nodes); no record value bytes are read here.
  const leaves = await repo.data.listWithPrefix(prefix)
  // MST order is ascending by key == ascending by rkey within a collection.
  const ordered = input.reverse ? leaves : leaves.slice().reverse()

  let start = 0
  if (input.cursor) {
    const cursorKey = prefix + input.cursor
    start = ordered.findIndex((l) =>
      input.reverse ? l.key > cursorKey : l.key < cursorKey,
    )
    if (start === -1) start = ordered.length
  }
  const page = ordered.slice(start, start + limit)

  const records: RecordEntry[] = []
  for (const leaf of page) {
    const { collection, rkey } = parseDataKey(leaf.key)
    const rawValue = await repo.storage.readRecord(leaf.value)
    records.push({
      uri: `at://${did}/${collection}/${rkey}`,
      cid: leaf.value.toString(),
      value: normalizeCidsToIpldJson(rawValue),
    })
  }

  const out: ListRecordsOutput = { records }
  if (start + limit < ordered.length && page.length > 0) {
    out.cursor = parseDataKey(page[page.length - 1].key).rkey
  }
  return out
}

/**
 * Exact number of records in a collection. Reads MST nodes only (no record
 * value bytes).
 */
export async function countRecords(
  storage: RepoStorage,
  collection: string,
): Promise<number> {
  const { repo } = await loadRepoOrThrow(storage)
  return (await repo.data.listWithPrefix(collection + '/')).length
}

/**
 * Point read of one record by rkey: an MST `get` (O(depth)) plus a single
 * value read. Never scans the collection. Null when absent.
 */
export async function getRecordByRkey(
  storage: RepoStorage,
  did: string,
  collection: string,
  rkey: string,
): Promise<RecordEntry | null> {
  const { repo } = await loadRepoOrThrow(storage)
  const cid = await repo.data.get(`${collection}/${rkey}`)
  if (!cid) return null
  const rawValue = await repo.storage.readRecord(cid)
  return {
    uri: `at://${did}/${collection}/${rkey}`,
    cid: cid.toString(),
    value: normalizeCidsToIpldJson(rawValue),
  }
}

// ---------------------------------------------------------------------------
// describeRepo
// ---------------------------------------------------------------------------

/**
 * Describe the repo: DID, handle, and the distinct set of Lexicon collections
 * present in the MST.
 *
 * Collections are derived by walking all MST leaves and collecting distinct
 * collection segments from the "collection/rkey" key format.
 */
export async function describeRepo(
  storage: RepoStorage,
  did: string,
  handle: string,
): Promise<DescribeRepoOutput> {
  const { repo } = await loadRepoOrThrow(storage)

  // Walk all leaves to collect distinct collections
  const collections = new Set<string>()
  const allLeaves = await repo.data.list()
  for (const leaf of allLeaves) {
    const { collection } = parseDataKey(leaf.key)
    collections.add(collection)
  }

  return {
    did,
    handle,
    collections: Array.from(collections).sort(),
    handleIsCorrect: true,
  }
}
