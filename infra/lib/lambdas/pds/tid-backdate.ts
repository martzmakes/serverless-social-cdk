/**
 * tid-backdate.ts — convert an original publish date into a valid AT-Proto TID rkey.
 *
 * AT-Proto TID format (from @atproto/common-web):
 *   TID.fromTime(timeMicros: number, clockid: number): TID
 *   - timeMicros: microseconds since Unix epoch (ms * 1000 + sub-ms counter)
 *   - clockid: 0–31, stored in the low 2 chars of the 13-char s32 string
 *   - Lexicographic order of the resulting string matches chronological order
 *     because s32 uses the character set '234567abcdefghijklmnopqrstuvwxyz'
 *     which is already ASCII-sort-ordered.
 *
 * Strategy for historical backfill:
 *   timeMicros = Date.parse(dateISO) * 1000 + seq
 *
 *   - `Date.parse(dateISO)` returns the midnight-UTC millisecond for the day.
 *     Multiplied by 1000 → microseconds. This is the dominant ordering term;
 *     any two dates at least 1 day apart differ by 86,400,000,000 µs, which
 *     is far larger than any seq value in a 50-post backfill.
 *   - `seq` (0, 1, 2, …) is added to the low microsecond bits. Because seq
 *     values are small integers and the next-day boundary is 86.4 billion µs
 *     away, same-date posts are strictly increasing by seq AND still fall
 *     within the same UTC day bucket. No seq value can overflow into the
 *     next day even for seq = 999.
 *   - clockid = 0 (fixed). The clockid field does not participate in ordering
 *     for this use-case; using 0 keeps output deterministic.
 *
 * Guarantees:
 *   1. Earlier dateISO → lexicographically-smaller TID (historical ordering).
 *   2. Same dateISO, different seq → strictly increasing & unique TIDs.
 *   3. Same-date TIDs stay within the UTC day bucket (>= midnight, < next midnight).
 *   4. Deterministic: same (dateISO, seq) always produces the same string.
 *   5. Output is a real TID accepted by TID.fromStr() without throwing.
 */

import { TID } from '@atproto/common-web'

/**
 * Returns a valid, historically-sorting AT-Proto TID rkey for a post
 * originally published on `dateISO` (YYYY-MM-DD, UTC midnight).
 *
 * @param dateISO - Original publish date, e.g. '2021-07-30'
 * @param seq     - 0-based sequence number for posts sharing the same date;
 *                  ensures uniqueness and stable ordering within a day.
 */
export function tidForPublish(dateISO: string, seq: number): string {
  const timeMicros = Date.parse(dateISO) * 1000 + seq
  return TID.fromTime(timeMicros, 0).toString()
}
