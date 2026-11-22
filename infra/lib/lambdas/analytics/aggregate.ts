// aggregate.ts — idempotent S3-ObjectCreated CloudFront-log aggregator (Task 2).
//
// Replaces the Task-1 stub. Pipeline: S3 `cf/`-key OBJECT_CREATED → gunzip →
// parseCloudFrontLog (ZERO-PII ViewEvent[]) → per-slug atomic ADD rollups in
// PostAnalyticsTable → a PROCESSED# DONE-marker committed LAST, only on
// full-file success.
//
// ───────────────────────────────────────────────────────────────────────────
// CORRECTNESS INVARIANT (load-bearing — S3→Lambda is at-least-once; a wrongly
// committed marker => permanently inflated counts; a too-early durable marker
// => permanently lost data on a crash). The behavioral contract is fixed by
// the two tests in infra/test/analytics/aggregate.test.ts and implemented
// EXACTLY as below:
//
//   IDENTITY: the object key. Two marker rows are used, both under the SAME
//   logical key namespace, with the DONE-row being the single source of truth
//   for "this file was FULLY aggregated":
//     • CLAIM row : { pk:'CLAIM#'+key,     sk:'LOG' }  — concurrency/redelivery
//                                                        de-dup latch.
//     • DONE  row : { pk:'PROCESSED#'+key, sk:'LOG' }  — committed LAST, only
//                                                        on full success.
//
//   1. CLAIM (single conditional PutCommand, attribute_not_exists(pk)):
//      try to write the CLAIM row. If ConditionalCheckFailed → another
//      delivery already claimed/processed this exact object → return
//      { processed:false, views:0 } (idempotent: no re-aggregation, no
//      double-count of a redelivered/duplicate S3 event — the COMMON case
//      this whole scheme exists to defeat). [This claims the file.]
//   2. gunzipSync(gz) → parseCloudFrontLog → ViewEvent[] (slug / eTLD+1
//      referrerHost / uaClass — already PII-stripped upstream; we add NOTHING
//      back: never an IP/cookie/full-URL/per-user value).
//   3. For each ViewEvent: branch on uaClass. NO nested-map document paths are
//      ever written (DynamoDB deterministically REJECTS a single
//      UpdateExpression that touches both a top-level attribute and a
//      `.`-qualified sub-path of it: `ValidationException: Two document paths
//      overlap`). EVERY UpdateExpression below is a SINGLE pure top-level
//      `ADD` — a server-side atomic read-modify-write that DynamoDB serializes
//      PER ITEM, so concurrent log-file Lambdas compose correctly (no lost
//      updates, no client RMW, no overlapping-path ValidationException):
//
//      ── BOT EXCLUSION (spec §2.1/§6/§8 — load-bearing) ──────────────────────
//        Spec §2.1: "bots excluded from views"; §6: bot-filtered so `views`
//        approximate human reads; §8 DoD: per-slug/day bot-FILTERED counts.
//        Crawler traffic is frequently the majority of hits — counting bots in
//        `views` makes the headline metric misleading. Therefore:
//          • uaClass === 'human' → main `ADD #v :one, #uh :one, #cv :one, #src :one, #device :one` (views,
//            uaHuman, classification coverage, source, and device) AND the per-referrer-host `ADD #c :one`. The full
//            human-read picture: views + uaHuman + a REF# row.
//          • uaClass === 'bot'  → ONLY main `ADD #ub :one` (uaBot). NO `#v`
//            (views) increment; NO `REF#` row (a bot's referrer is noise —
//            the spec wants referrers OF human reads).
//
//      ── TASK 17 KEY CHANGE ── every `VIEW#<slug>` pk below is now
//      `VIEW#<host>#<slug>` for NEW data (host = x-host-header, www-stripped),
//      and the sk day is the log row's own date. Legacy `VIEW#<slug>` rows are
//      never rewritten or deleted; readers fold them in (see
//      mcp/tools/page-views.ts). Slug validity (is it a real longform?) is
//      checked at READ time against the longform index, not here.
//
//      ── DATA MODEL (Task-4 reader contract — read these rows accordingly) ──
//        • Main rollup row:
//            { pk:'VIEW#'+slug, sk:utcDay }
//            attrs: views (Number, HUMAN-ONLY), uaHuman (Number),
//                   uaBot (Number — separate bot-volume sidecar)
//          One per (slug, utcDay). `views` == HUMAN ViewEvents that day
//          (== uaHuman); `uaBot` is the distinct bot-volume counter and is
//          NOT included in `views`. The Task-4 reader sums `views` into
//          `totalViews` → that is therefore the HUMAN-read total (spec-faithful;
//          no read.ts change needed — summing the now-human-only `views` is
//          strictly MORE correct). `uaBot` is available as a sidecar should a
//          future reader want bot volume.
//        • Per-referrer rollup rows (one discrete item PER host) — HUMAN-ONLY:
//            { pk:'VIEW#'+slug, sk:'REF#'+utcDay+'#'+referrerHost }
//            attrs: count (Number)
//          Written ONLY for human events (bots produce no REF# row). The
//          reader (Task 4) MUST roll referrers up at query time by Query-ing
//          pk='VIEW#'+slug and bucketing every sk that begins with
//          'REF#'+utcDay+'#' — the trailing segment after that prefix is the
//          eTLD+1 host (host-only; zero PII), its `count` the per-host human
//          views.
//      ────────────────────────────────────────────────────────────────────
//   4. ON FULL SUCCESS ONLY: a single conditional `PutCommand`
//      (attribute_not_exists(pk)) writing the DONE row. This is the LAST
//      write. A ConditionalCheckFailed here means a concurrent in-flight
//      duplicate already committed — benign (its ADDs already happened); we
//      still return processed:true,views for THIS run's observed work.
//   5. return { processed:true, views }.
//
//   FAIL-CLOSED + RETRY-SAFE: if gunzip/parse or ANY UpdateCommand throws, we
//   (a) best-effort DELETE the CLAIM row so a retry is NOT permanently
//   skipped, then (b) rethrow. We NEVER reach step 4 → NO DONE row is ever
//   written on a failed run. S3/Lambda at-least-once redelivers; the retry
//   re-claims and re-aggregates from scratch. The DONE row existing ⟺ a prior
//   run reached full success.
//
//   DOCUMENTED TRADE-OFF (accepted contract): marker-on-full-success-only
//   ordering makes the COMMON redelivery (a successfully-processed file
//   delivered again) a no-op — no double count. The catch-rollback of the
//   CLAIM row makes the COMMON in-process failure (DDB blip, parse error)
//   safely retryable. The RARE residual: a hard instance-kill BETWEEN some
//   atomic ADDs and the catch-rollback leaves a CLAIM row with no DONE row;
//   the CLAIM row's TTL eventually expires, after which a (much later)
//   redelivery would re-aggregate that file — re-adding all of it and
//   double-counting only whatever the killed attempt had already ADDed.
//   True exactly-once across a mid-instance-kill is expensive (per-event
//   dedup keys); the spec's accepted contract is: redelivery-idempotent +
//   retry-safe + fail-closed, with the rare instance-kill partial-recount as
//   the explicit, documented trade-off (strictly better than the
//   alternatives of permanent skip-with-missing-data or a marker-first
//   double-count of every single redelivery).
// ───────────────────────────────────────────────────────────────────────────

import { gunzipSync } from 'node:zlib'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { parseCloudFrontLog } from './log-parse'
import { addExpression, rollupEvents } from './rollup'

// 35-day TTL on the marker rows — comfortably outlives the ≤30d log retention
// so a redelivered in-window object can never sneak past an expired marker.
// Mirrors the xrpc-jti `ttl(sec)` idiom (Math.floor(now/1000) + sec).
const MARKER_TTL_SEC = 35 * 86400
const ttl = (sec: number) => Math.floor(Date.now() / 1000) + sec

// Mirrors infra/lib/lambdas/pds/xrpc-jti.ts:isConditionalCheckFailed — the
// conditional-PutCommand `attribute_not_exists` + name-based
// ConditionalCheckFailedException detection idiom.
function isConditionalCheckFailed(err: any): boolean {
  return err?.name === 'ConditionalCheckFailedException'
}

type Doc = { send: (cmd: any) => Promise<any> }

/**
 * Idempotent aggregation of one CloudFront log object.
 *
 * @param key    the S3 object key (the marker idempotency identity)
 * @param gz     the gzip'd CloudFront standard-log bytes
 * @param doc    @aws-sdk/lib-dynamodb DocumentClient (no new dep)
 * @param table  PostAnalyticsTable name
 * @returns { processed, views }: processed=false/views=0 ⟺ a prior delivery
 *          already claimed/processed this key (skip, no double-count);
 *          processed=true/views=N ⟺ N views aggregated + DONE marker committed.
 *          Throws (fail-closed) on gunzip/parse/Update failure — NO DONE
 *          marker written + CLAIM rolled back → a retry safely re-processes.
 */
/** Owner networks to ignore, from ANALYTICS_EXCLUDE_CIDRS (comma-separated). */
function excludeCidrs(): string[] {
  return (process.env.ANALYTICS_EXCLUDE_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export async function aggregateLogObject(
  key: string,
  gz: Buffer,
  doc: Doc,
  table: string,
): Promise<{ processed: boolean; views: number }> {
  const claimKey = { pk: 'CLAIM#' + key, sk: 'LOG' }
  const doneKey = { pk: 'PROCESSED#' + key, sk: 'LOG' }

  // Step 1 — CLAIM. Conditional create; if it already exists, this object was
  // already claimed/processed by another (re)delivery → skip entirely (no
  // re-aggregation, no double-count). This is the common-case idempotency.
  try {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { ...claimKey, ttl: ttl(MARKER_TTL_SEC) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
  } catch (err: any) {
    if (isConditionalCheckFailed(err)) return { processed: false, views: 0 }
    throw err
  }

  try {
    // Step 2 — decompress + PII-stripped parse (parseCloudFrontLog returns
    // ONLY slug / eTLD+1 referrerHost / uaClass; we add nothing back).
    const raw = gunzipSync(gz)
    const events = parseCloudFrontLog(raw, { excludeCidrs: excludeCidrs() })

    // utcDay: parseCloudFrontLog does NOT surface the per-row date (by design
    // — surfacing raw row fields risks PII creep), so we bucket by "now" UTC
    // day. Acceptable & documented: CloudFront delivers standard logs
    // same-day-ish, so the now-day is within ~hours of the request day; the
    // spec accepts this simplification over re-parsing date fields. NO PII is
    // read to derive it.
    // Task 17: the day is the log row's own `date` (UTC), so a log delivered
    // late (or after midnight) still lands on the day the page was served.
    // `now` is only a fallback for a row without a parseable date.
    const nowDay = new Date().toISOString().slice(0, 10)

    // Step 3 — per-event atomic rollup, BRANCHED on uaClass for spec-faithful
    // bot exclusion (spec §2.1/§6/§8 — bots are NOT counted in `views` and
    // produce NO referrer row). EVERY UpdateExpression here is a SINGLE pure
    // top-level `ADD` (NEVER a single expression touching both a map and its
    // sub-path — DynamoDB rejects overlapping document paths at
    // expression-validation, before touching the item). Each branch's
    // command(s) are disjoint numeric counters / discrete items, so concurrent
    // log-file Lambdas compose correctly (no lost updates, no client RMW, no
    // overlapping-path ValidationException):
    //   HUMAN (uaClass !== 'bot'):
    //     (a) MAIN     Key {pk:'VIEW#'+slug, sk:utcDay}
    //                 `ADD #v :one, #uh :one, #cv :one, #src :one, #device :one`   (views and attribution)
    //     (b) REFERRER Key {pk:'VIEW#'+slug, sk:'REF#'+utcDay+'#'+host}
    //                 `ADD #c :one`             (this host's discrete count)
    //   BOT (uaClass === 'bot'):
    //     (a) MAIN     Key {pk:'VIEW#'+slug, sk:utcDay}
    //                 `ADD #ub :one`            (uaBot ONLY — NO views, NO REF#)
    // `views` returned == number of ViewEvents whose MAIN ADD succeeded (i.e.
    // events processed without error — humans contribute views+uaHuman+REF#,
    // bots contribute uaBot only; the AGGREGATED `views` ATTRIBUTE on the row
    // is HUMAN-ONLY, see DATA MODEL above). The returned counter stays the
    // count of successfully-processed events so the two Task-2 behavioral
    // tests' INTENT (idempotent no-double-count; mid-throw retry-safe) is
    // unweakened — it is a processed-event count, NOT the human-views metric.
    // Requests for the same page/day in this file are summed first, then each
    // row gets one ADD carrying all of its counters (see rollup.ts).
    for (const row of rollupEvents(events, nowDay)) {
      await doc.send(new UpdateCommand({ TableName: table, Key: row.key, ...addExpression(row.counters) }))
    }
    const views = events.length

    // Step 4 — commit the DONE marker LAST, only after every event succeeded.
    // Conditional attribute_not_exists(pk): a concurrent in-flight duplicate
    // that committed first → ConditionalCheckFailed here, which is benign
    // (idempotent: its ADDs already landed; this run still reports its own
    // observed work). Any other error propagates.
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { ...doneKey, state: 'DONE', ttl: ttl(MARKER_TTL_SEC) },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
    } catch (err: any) {
      if (!isConditionalCheckFailed(err)) throw err
      // Concurrent duplicate already committed the DONE marker — benign.
    }

    // Step 5
    return { processed: true, views }
  } catch (err) {
    // FAIL-CLOSED + RETRY-SAFE: never wrote a DONE marker. Best-effort
    // release the CLAIM so the at-least-once retry is NOT permanently
    // skipped; then rethrow so S3/Lambda redelivers.
    try {
      await doc.send(new DeleteCommand({ TableName: table, Key: claimKey }))
    } catch {
      // Swallow rollback failure — the original error is what matters; the
      // CLAIM row's TTL is the backstop (documented trade-off above).
    }
    throw err
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Module-level cached clients (built once per warm Lambda, like other Lambdas
// e.g. ap-deps.ts `DynamoDBDocumentClient.from(new DynamoDBClient({}))` and
// pds/handler.ts `new S3Client({})`).
// ───────────────────────────────────────────────────────────────────────────
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

/**
 * Real S3 ObjectCreated handler. For each record: GetObject the `cf/`-key
 * (URL-decoded — S3 encodes object keys in event notifications), body→Buffer,
 * delegate to aggregateLogObject. Errors propagate so S3/Lambda retries
 * (at-least-once) — the CLAIM/DONE markers make the retry idempotent.
 */
export const handler = async (event: any): Promise<void> => {
  const table = process.env.POST_ANALYTICS_TABLE!
  for (const record of event?.Records ?? []) {
    const bucket = record.s3.bucket.name
    // S3 event-notification keys are URL-encoded (spaces → '+', etc.).
    const key = decodeURIComponent(
      String(record.s3.object.key).replace(/\+/g, ' '),
    )
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )
    if (!res.Body) continue
    const bytes = await (res.Body as any).transformToByteArray()
    await aggregateLogObject(key, Buffer.from(bytes), docClient, table)
  }
}
