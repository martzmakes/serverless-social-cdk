/**
 * ap/retry.ts - SQS consumer for the ActivityPub delivery retry queue.
 *
 * Producers (ap/deliver.ts stream consumer, ap/handler.ts Accept) enqueue
 * RetryMessages after a transient failure (5xx / 429 / 408 / network) or when a
 * longform page is not published yet. This Lambda re-attempts them.
 *
 * BACKOFF + DLQ without bookkeeping of our own: a failed message is reported
 * as a batch-item failure after its visibility timeout is set to an
 * exponential backoff derived from SQS's own ApproximateReceiveCount. The
 * queue's redrive policy (maxReceiveCount, see infra-stack.ts) moves it to the
 * DLQ once the attempts are spent. With the 30 s first delay and x4 growth the
 * attempts happen at roughly +30 s, +1 min, +3 min, +11 min, +43 min, +2.8 h.
 *
 * The send itself goes through the same ledger-guarded deliverOne as the
 * stream consumer, so SQS's at-least-once delivery cannot double-deliver.
 */

import {
  processOne,
  redeliver,
  type DeliverDeps,
  type RetryMessage,
} from './deliver'

/** First backoff after the first failed retry; grows x4 per attempt. */
export const BACKOFF_BASE_SECONDS = 30
/** SQS allows up to 12 h; cap lower, a day-old retry is not worth holding. */
export const BACKOFF_MAX_SECONDS = 6 * 60 * 60

/** Visibility timeout to apply after the Nth receive failed (N >= 1). */
export function backoffSeconds(receiveCount: number): number {
  const n = Math.max(1, Math.trunc(receiveCount))
  return Math.min(BACKOFF_BASE_SECONDS * 4 ** (n - 1), BACKOFF_MAX_SECONDS)
}

export interface SqsRecordLike {
  messageId: string
  receiptHandle: string
  body: string
  attributes?: { ApproximateReceiveCount?: string }
}

export interface RetryBatchResponse {
  batchItemFailures: { itemIdentifier: string }[]
}

/** Process one parsed message. Throws when SQS should redrive it. */
export async function processRetryMessage(
  msg: RetryMessage,
  deps: DeliverDeps,
): Promise<void> {
  if (msg.kind === 'deliver') {
    await redeliver(msg, deps)
    return
  }
  if (msg.kind === 'event') {
    // 'retry' mode: a not-ready page throws NotReadyError -> SQS backoff.
    await processOne(msg.event, deps, 'retry')
    return
  }
  throw new Error('unknown retry message kind')
}

export async function processRetryBatch(
  records: SqsRecordLike[],
  deps: DeliverDeps,
  changeVisibility: (receiptHandle: string, seconds: number) => Promise<void>,
): Promise<RetryBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = []
  for (const rec of records) {
    try {
      const msg = JSON.parse(rec.body) as RetryMessage
      await processRetryMessage(msg, deps)
    } catch (e: any) {
      const receives = Number(rec.attributes?.ApproximateReceiveCount ?? '1') || 1
      const delay = backoffSeconds(receives)
      console.warn(
        JSON.stringify({
          at: 'ap.retry',
          event: 'retry_failed',
          messageId: rec.messageId,
          receives,
          nextAttemptInSeconds: delay,
          message: e?.message,
        }),
      )
      try {
        await changeVisibility(rec.receiptHandle, delay)
      } catch (ce: any) {
        // Falls back to the queue's default visibility timeout.
        console.error(
          JSON.stringify({
            at: 'ap.retry',
            event: 'change_visibility_failed',
            messageId: rec.messageId,
            message: ce?.message,
          }),
        )
      }
      batchItemFailures.push({ itemIdentifier: rec.messageId })
    }
  }
  return { batchItemFailures }
}

export async function handler(event: {
  Records: SqsRecordLike[]
}): Promise<RetryBatchResponse> {
  // Deferred import - same M2 pattern as deliver.ts / handler.ts.
  const { makeDeliverDeps, makeChangeVisibility } = await import('../ap-deps.js')
  return processRetryBatch(
    event.Records ?? [],
    makeDeliverDeps(),
    makeChangeVisibility(),
  )
}
