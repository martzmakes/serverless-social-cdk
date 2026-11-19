/**
 * firehose-core.ts — transport-agnostic cursor/replay logic for the AT Protocol
 * subscribeRepos firehose.
 *
 * Extracted from firehose-ws.ts so the same logic can be shared by the
 * API-GW Lambda handler and the local box WebSocket server (Task 2+).
 *
 * NO aws-lambda / ws / API-GW imports — pure logic only.
 */

import {
  DynamoDBClient,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

// Re-export sequencer helpers so consumers have one import surface.
export {
  parseEventFrame,
  verifyEventCommit,
  encodeInfoFrame,
  encodeErrorFrame,
  pad16,
} from './sequencer'

import { encodeInfoFrame, encodeErrorFrame, pad16 } from './sequencer'

// ---------------------------------------------------------------------------
// parseCursor
// ---------------------------------------------------------------------------

/**
 * Parse the raw `?cursor=` query-string value into a number.
 *
 * Returns `undefined` if the value is absent, non-numeric, or negative.
 * Callers that want a default of 0 should use `parseCursor(s) ?? 0`.
 */
export function parseCursor(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const n = parseInt(s, 10)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}

// ---------------------------------------------------------------------------
// fetchEvtRange — deterministic computed-key BatchGet
// ---------------------------------------------------------------------------

/** BatchGetItem in chunks of ≤100; handles UnprocessedKeys with bounded retries. */
async function batchGetAllItems(
  ddb: DynamoDBClient,
  table: string,
  keys: Array<Record<string, AttributeValue>>,
): Promise<Array<Record<string, AttributeValue>>> {
  const CHUNK = 100
  const MAX_RETRIES = 5
  const collected: Array<Record<string, AttributeValue>> = []

  for (let i = 0; i < keys.length; i += CHUNK) {
    let pending = keys.slice(i, i + CHUNK)
    let attempt = 0

    while (pending.length > 0 && attempt < MAX_RETRIES) {
      const res = await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [table]: { Keys: pending },
          },
        }),
      )
      for (const item of res.Responses?.[table] ?? []) {
        collected.push(item)
      }
      const unprocessed = res.UnprocessedKeys?.[table]?.Keys ?? []
      pending = unprocessed
      if (pending.length > 0) attempt++
    }
    // Silently drop remaining unprocessed keys after MAX_RETRIES
    // (same treatment as TTL-expired keys — caller treats missing as absent).
  }

  return collected
}

/**
 * BatchGet all retained EVT# frames in (fromExclusive, toInclusive] by
 * computing exact keys. Chunks ≤100, retries UnprocessedKeys (bounded).
 * Returns frames sorted ascending by seq, plus earliestRetainedSeq.
 *
 * `table` is a parameter (not closed over) so this function can be reused
 * across multiple PDS instances pointing at different tables.
 */
export async function fetchEvtRange(
  ddb: DynamoDBClient,
  table: string,
  fromExclusive: number,
  toInclusive: number,
): Promise<{
  frames: Array<{ seq: number; frame: Uint8Array }>
  earliestRetainedSeq: number | null
}> {
  const keys: Array<Record<string, AttributeValue>> = []
  for (let seq = fromExclusive + 1; seq <= toInclusive; seq++) {
    keys.push({ pk: { S: `EVT#${pad16(seq)}` }, sk: { S: 'EVT' } })
  }
  if (keys.length === 0) {
    return { frames: [], earliestRetainedSeq: null }
  }
  const items = await batchGetAllItems(ddb, table, keys)
  const results: Array<{ seq: number; frame: Uint8Array }> = []
  for (const item of items) {
    const raw = item.frame?.B
    if (!raw) continue
    const frame =
      raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike)
    results.push({ seq: Number(item.seq?.N), frame })
  }
  results.sort((a, b) => a.seq - b.seq)
  const earliestRetainedSeq = results.length > 0 ? results[0].seq : null
  return { frames: results, earliestRetainedSeq }
}

// ---------------------------------------------------------------------------
// planReplay — the cursor decision logic
// ---------------------------------------------------------------------------

export type ReplayResult = {
  mode: 'future' | 'outdated' | 'ok'
  frames: Uint8Array[]
  /** Present when mode === 'outdated': the #info OutdatedCursor frame to send first. */
  info?: Uint8Array
  /** Present when mode === 'future': the op:-1 FutureCursor error frame to send. */
  error?: Uint8Array
}

/**
 * Decide what to send for a given cursor vs. the current stream head.
 *
 * @param currentSeq  - The current maximum seq (0 = empty stream).
 * @param cursor      - The cursor the client provided (undefined = no cursor → 0).
 * @param fetchRange  - Injectable range fetcher: (fromExclusive, toInclusive) →
 *                      { frames, earliestRetainedSeq }. Use `fetchEvtRange` for
 *                      real DDB; inject a stub for tests.
 *
 * Decisions (byte-identical to the original handleReplay logic):
 *   cursor > currentSeq              → mode:'future' + FutureCursor error frame
 *   currentSeq === 0                 → mode:'ok', no frames
 *   cursor >= currentSeq             → mode:'ok', no frames
 *   cursor > 0 && earliest > cursor+1 → mode:'outdated' + #info OutdatedCursor + frames
 *   otherwise                        → mode:'ok' + frames
 */
export async function planReplay(
  currentSeq: number,
  cursor: number | undefined,
  fetchRange: (
    fromExclusive: number,
    toInclusive: number,
  ) => Promise<{
    frames: Array<{ seq: number; frame: Uint8Array }>
    earliestRetainedSeq: number | null
  }>,
): Promise<ReplayResult> {
  // Normalise: undefined → 0 (replay from beginning)
  const numericCursor = cursor ?? 0

  if (numericCursor > currentSeq) {
    return {
      mode: 'future',
      frames: [],
      error: encodeErrorFrame(
        'FutureCursor',
        `Requested cursor ${numericCursor} is ahead of the current stream head (seq ${currentSeq})`,
      ),
    }
  }

  if (currentSeq === 0) {
    return { mode: 'ok', frames: [] }
  }

  const replayFromExclusive = numericCursor
  if (replayFromExclusive >= currentSeq) {
    return { mode: 'ok', frames: [] }
  }

  const { frames: rawFrames, earliestRetainedSeq } = await fetchRange(
    replayFromExclusive,
    currentSeq,
  )

  const frameBytes = rawFrames.map(({ frame }) => frame)

  if (
    numericCursor > 0 &&
    earliestRetainedSeq !== null &&
    earliestRetainedSeq > replayFromExclusive + 1
  ) {
    return {
      mode: 'outdated',
      info: encodeInfoFrame('OutdatedCursor'),
      frames: frameBytes,
    }
  }

  return { mode: 'ok', frames: frameBytes }
}
