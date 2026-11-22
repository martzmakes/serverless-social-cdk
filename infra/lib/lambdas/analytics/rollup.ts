// Pure rollup of parsed page views into PostAnalyticsTable counter rows.
//
// One log file usually holds several requests for the same page and day, so
// events are summed in memory first and each (pk, sk) row gets ONE atomic
// `ADD` with all of its counters. That keeps concurrent aggregators correct
// (DynamoDB serializes ADDs per item) while writing far fewer items than one
// update per request. The live aggregator and the backfill script share it.
//
// Row model (all numeric counters, top-level attributes only):
//   Article   pk VIEW#<host>#<slug>   sk <day>              views, uaHuman, uaBot, classifiedViews,
//                                                            source_<s>, device_<d>, geo_<CC>, edge_<XXX>
//             pk VIEW#<host>#<slug>   sk REF#<day>#<domain> count
//   Home page pk HOME#<host>          sk <day> | REF#<day>#<domain>   (same attributes as an article)
//   Short post pk POSTVIEW#<host>     sk <day>#<actor>#<rkey>          (article attributes, no REF rows)
// Bots only add `uaBot` to the main row and never produce referrer rows.

import type { ViewEvent } from './log-parse'

export type RowKey = { pk: string; sk: string }
export type CounterRow = { key: RowKey; counters: Record<string, number> }

export function mainKey(ev: ViewEvent, day: string): RowKey {
  if (ev.kind === 'home') return { pk: `HOME#${ev.host}`, sk: day }
  if (ev.kind === 'post') return { pk: `POSTVIEW#${ev.host}`, sk: `${day}#${ev.actor}#${ev.slug}` }
  return { pk: `VIEW#${ev.host}#${ev.slug}`, sk: day }
}

export function rollupEvents(events: readonly ViewEvent[], fallbackDay: string): CounterRow[] {
  const rows = new Map<string, CounterRow>()
  const add = (key: RowKey, name: string, n = 1) => {
    const id = `${key.pk}\u0000${key.sk}`
    let row = rows.get(id)
    if (!row) rows.set(id, (row = { key, counters: {} }))
    row.counters[name] = (row.counters[name] ?? 0) + n
  }
  for (const ev of events) {
    const day = ev.day ?? fallbackDay
    const key = mainKey(ev, day)
    if (ev.uaClass === 'bot') {
      add(key, 'uaBot')
      continue
    }
    for (const name of ['views', 'uaHuman', 'classifiedViews', `source_${ev.source}`, `device_${ev.device}`, `geo_${ev.country}`]) {
      add(key, name)
    }
    if (ev.edge) add(key, `edge_${ev.edge}`)
    if (ev.kind !== 'post') add({ pk: key.pk, sk: `REF#${day}#${ev.referrerHost}` }, 'count')
  }
  return [...rows.values()]
}

/** A single pure top-level ADD for every counter on the row. */
export function addExpression(counters: Record<string, number>) {
  const names: Record<string, string> = {}
  const values: Record<string, number> = {}
  const parts = Object.entries(counters).map(([name, n], i) => {
    names[`#a${i}`] = name
    values[`:a${i}`] = n
    return `#a${i} :a${i}`
  })
  return {
    UpdateExpression: `ADD ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}
