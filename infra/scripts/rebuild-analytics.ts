// Rebuild page-view rollups for a range of complete UTC days from CloudFront
// standard logs, using the same parser and rollup as the live aggregator.
//
// Use it after changing how views are classified, for days whose raw logs are
// still retained (the log bucket keeps 30 days). It replaces, for the hosts and
// days given, every article/home/short-post counter row and referrer row with
// the recomputed values. Rows outside the range and PROCESSED#/CLAIM# markers
// are untouched. Only rebuild days that have finished (yesterday or earlier),
// so the live aggregator is not writing to them at the same time.
//
//   node rebuild-analytics.cjs --logs <dir of .gz> --table <PostAnalyticsTable>
//     --from 2026-10-22 --to 2026-11-21 --hosts example.com,other.example
//     [--exclude 198.51.100.0/24,...] [--apply]
//
// Without --apply it only prints a summary of the rebuilt counts.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { parseCloudFrontLog, type ViewEvent } from '../lib/lambdas/analytics/log-parse'
import { rollupEvents, type CounterRow } from '../lib/lambdas/analytics/rollup'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const logs = arg('logs')
const table = arg('table')
const from = arg('from')
const to = arg('to')
const hosts = new Set(list(arg('hosts')))
const apply = process.argv.includes('--apply')
const day = /^\d{4}-\d{2}-\d{2}$/
if (!logs || !table || !from || !to || !day.test(from) || !day.test(to) || from > to || !hosts.size) {
  console.error('Usage: --logs <dir> --table <name> --from YYYY-MM-DD --to YYYY-MM-DD --hosts a,b [--exclude cidrs] [--apply]')
  process.exit(2)
}
const today = new Date().toISOString().slice(0, 10)
if (to >= today) {
  console.error(`--to must be a finished UTC day (before ${today}).`)
  process.exit(2)
}

/** Which day a row belongs to, or undefined when it is not a page-view row. */
function rowDay(pk: string, sk: string): string | undefined {
  const host = pk.startsWith('VIEW#') ? pk.split('#')[1] : pk.startsWith('HOME#') || pk.startsWith('POSTVIEW#') ? pk.slice(pk.indexOf('#') + 1) : undefined
  // Legacy VIEW#<slug> rows predate per-host keys; leave them alone.
  if (!host || !hosts.has(host) || (pk.startsWith('VIEW#') && pk.split('#').length < 3)) return undefined
  const value = sk.startsWith('REF#') ? sk.slice(4, 14) : sk.slice(0, 10)
  return day.test(value) ? value : undefined
}

async function main() {
  const events: ViewEvent[] = []
  const files = readdirSync(logs!).filter((name) => name.endsWith('.gz'))
  for (const name of files) {
    for (const event of parseCloudFrontLog(gunzipSync(readFileSync(join(logs!, name))), { excludeCidrs: list(arg('exclude')) })) {
      if (event.day && event.day >= from! && event.day <= to! && hosts.has(event.host)) events.push(event)
    }
  }
  const rows = rollupEvents(events, to!)
  const summary = new Map<string, { human: number; bot: number }>()
  for (const ev of events) {
    const key = `${ev.host} ${ev.kind}`
    const entry = summary.get(key) ?? { human: 0, bot: 0 }
    entry[ev.uaClass === 'bot' ? 'bot' : 'human']++
    summary.set(key, entry)
  }
  console.log(`${files.length} log files, ${events.length} page requests ${from}..${to}, ${rows.length} rows`)
  for (const [key, n] of [...summary].sort()) console.log(`  ${key}: ${n.human} human, ${n.bot} automated`)
  if (!apply) {
    console.log('Dry run. Pass --apply to replace the stored rows.')
    return
  }

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const stale: { pk: string; sk: string }[] = []
  let cursor: Record<string, unknown> | undefined
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, ProjectionExpression: 'pk, sk', ExclusiveStartKey: cursor }))
    for (const item of page.Items ?? []) {
      const d = rowDay(String(item.pk), String(item.sk))
      if (d && d >= from! && d <= to!) stale.push({ pk: String(item.pk), sk: String(item.sk) })
    }
    cursor = page.LastEvaluatedKey
  } while (cursor)
  console.log(`Replacing ${stale.length} stored rows with ${rows.length} rebuilt rows`)

  const fresh = new Set(rows.map((r) => `${r.key.pk}\u0000${r.key.sk}`))
  const deletes = stale.filter((k) => !fresh.has(`${k.pk}\u0000${k.sk}`)).map((Key) => ({ DeleteRequest: { Key } }))
  const puts = rows.map((r: CounterRow) => ({ PutRequest: { Item: { ...r.key, ...r.counters } } }))
  const requests = [...puts, ...deletes]
  for (let i = 0; i < requests.length; i += 25) {
    let batch: any = { [table!]: requests.slice(i, i + 25) }
    for (let attempt = 0; batch && Object.keys(batch).length; attempt++) {
      const result = await doc.send(new BatchWriteCommand({ RequestItems: batch }))
      batch = result.UnprocessedItems && Object.keys(result.UnprocessedItems).length ? result.UnprocessedItems : undefined
      if (batch) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** Math.min(attempt, 6)))
    }
  }
  await doc.send(new PutCommand({
    TableName: table,
    Item: { pk: 'META#analytics', sk: 'reprocessed', from, to, at: new Date().toISOString() },
  }))
  console.log(`Done: ${puts.length} rows written, ${deletes.length} stale rows deleted.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
