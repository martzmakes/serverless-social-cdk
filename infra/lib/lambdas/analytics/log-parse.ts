// Pure CloudFront W3C *standard* access-log parser → longform ViewEvent[].
//
// Pinned to AWS's documented CloudFront standard access-log format: a
// `#Version:` line, a `#Fields:` line listing the tab-separated field order,
// then tab-separated data rows (`-` = empty; cs-uri-stem / cs(Referer) /
// cs(User-Agent) are URL-encoded). Parsing is driven BY the `#Fields:` header
// (name→index map) so AWS field-order drift does not break us.
//
// ZERO PII: this module never returns IPs, cookies, full URLs, query strings,
// or any per-user value — only { slug, referrerHost (eTLD+1), uaClass }.
//
// No new dependency: only `node:url` + a READ-ONLY import of the reserved-path
// logic that is the single source of truth shared with longform-edge.js.

import { isReserved } from '../pds/longform-routing'

export type ViewEvent = {
  slug: string
  /** Viewer-facing host (x-host-header, lowercased, `www.` stripped) or 'unknown'. */
  host: string
  /** UTC YYYY-MM-DD from the log row's own `date` field; undefined if absent/malformed. */
  day: string | undefined
  referrerHost: string
  uaClass: 'human' | 'bot'
}

const HOST_RE = /^[a-z0-9.-]+$/
/** Normalize a Host header value to a bare lowercase host without `www.`. */
function normHost(raw: string | undefined): string | undefined {
  if (!raw || raw === '-') return undefined
  let h = raw.toLowerCase().trim().replace(/:\d+$/, '')
  if (h.startsWith('www.')) h = h.slice(4)
  return h && HOST_RE.test(h) ? h : undefined
}

/**
 * eTLD+1 of a (URL-encoded) referrer. `-`/empty/undefined → 'direct'.
 * Unparseable → 'direct'. `www.` stripped; reduced to registrable domain.
 */
export function referrerHost(raw: string | undefined): string {
  if (raw === undefined || raw === '' || raw === '-') return 'direct'
  let url: URL
  try {
    const decoded = decodeURIComponent(raw)
    url = new URL(decoded)
  } catch {
    return 'direct'
  }
  let host = url.hostname.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  const labels = host.split('.')
  if (labels.length <= 2) return host
  // Pragmatic, intentionally NON-EXHAUSTIVE set of 2-level public suffixes
  // (NOT the full Public Suffix List — extend conservatively if needed).
  const TWO_LEVEL_SUFFIXES = new Set<string>([
    'co.uk', 'ac.uk', 'org.uk', 'gov.uk',
    'com.au', 'net.au', 'org.au',
    'co.nz', 'co.jp', 'com.br', 'co.in',
  ])
  const lastTwo = labels.slice(-2).join('.')
  const take = TWO_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2
  return labels.slice(-take).join('.')
}

/**
 * Classify a (possibly URL-encoded) User-Agent. `-`/empty/undefined → 'bot'
 * (no UA == automated). Known crawler/tool tokens → 'bot'; else 'human'.
 */
export function uaClass(raw: string | undefined): 'human' | 'bot' {
  if (raw === undefined || raw === '' || raw === '-') return 'bot'
  let ua = raw
  if (ua.includes('%')) {
    try { ua = decodeURIComponent(ua) } catch { /* keep raw */ }
  }
  ua = ua.toLowerCase()
  const BOT_TOKENS = [
    'bot', 'crawl', 'spider', 'slurp', 'bingpreview', 'facebookexternalhit',
    'embedly', 'headless', 'curl', 'wget', 'python-requests', 'go-http',
    'apache-httpclient', 'java/', 'okhttp',
    // Fediverse servers fetch a post when it is boosted/previewed/federated.
    'mastodon', 'http.rb', 'pleroma', 'akkoma', 'misskey', 'calckey', 'firefish',
    'friendica', 'gotosocial', 'pixelfed', 'lemmy', 'peertube', 'hubzilla',
    'activitypub', 'fediverse', 'bridgy', 'bluesky', 'cardyb',
    // Scripted fetchers / HTTP libraries / feed readers.
    'python-urllib', 'python/', 'aiohttp', 'httpx', 'node-fetch', 'axios', 'undici',
    'got (', 'libwww', 'httpie', 'postman', 'scrapy', 'mechanize', 'jetty',
    'ruby', 'php/', 'guzzle', 'perl', 'feedly', 'feedfetcher', 'newsblur',
    'inoreader', 'miniflux', 'tiny tiny rss', 'whatsapp', 'telegrambot', 'skypeuripreview',
    // NOT 'telegram': the Telegram in-app browser sends `... Telegram-Android/x`
    // for a real reader; the link-preview fetcher is `TelegramBot (like TwitterBot)`.
  ]
  return BOT_TOKENS.some((t) => ua.includes(t)) ? 'bot' : 'human'
}

// Reject longform slugs that are reserved files/assets the way longform-edge.js
// does. `isReserved` already covers the canonical RESERVED set + favicon* +
// index.html/sitemap.xml/rss.xml/atom.xml/robots.txt/og-default.png. We add a
// belt-and-suspenders check for the asset/file shapes the spec calls out
// explicitly (any *.xml, og-default.png, favicon*, robots.txt, index.html).
function isAssetOrReserved(slug: string): boolean {
  if (isReserved(slug)) return true
  if (slug === 'index.html' || slug === 'robots.txt') return true
  if (slug === 'og-default.png') return true
  if (slug.startsWith('favicon')) return true
  if (slug.endsWith('.xml')) return true
  return false
}

/**
 * Parse a CloudFront standard access-log buffer into longform ViewEvents.
 * Header-driven (reads fields by name); skips comments, blank lines, and any
 * malformed/short/erroring row without throwing. Only 200 GET text/html views
 * of a real top-level longform <slug> survive.
 */
export function parseCloudFrontLog(buf: Buffer): ViewEvent[] {
  const out: ViewEvent[] = []
  const lines = buf.toString('utf8').split('\n')
  let fieldIndex: Map<string, number> | null = null

  for (const line of lines) {
    if (line === '') continue
    if (line.startsWith('#')) {
      if (line.startsWith('#Fields:')) {
        const names = line.slice('#Fields:'.length).trim().split(/\s+/)
        const m = new Map<string, number>()
        names.forEach((n, idx) => m.set(n, idx))
        fieldIndex = m
      }
      continue
    }
    if (!fieldIndex) continue

    try {
      const cols = line.split('\t')
      if (cols.length < fieldIndex.size) continue // malformed/short → skip

      const get = (name: string): string | undefined => {
        const i = fieldIndex!.get(name)
        return i === undefined ? undefined : cols[i]
      }

      if (get('cs-method') !== 'GET') continue
      if (get('sc-status') !== '200') continue
      const ctype = get('sc-content-type')
      if (!ctype || !ctype.startsWith('text/html')) continue

      const rawUri = get('cs-uri-stem')
      if (!rawUri) continue
      let slug = decodeURIComponent(rawUri)
      slug = slug.replace(/^\/+/, '').replace(/\/+$/, '')
      if (!slug || slug.includes('/')) continue
      if (isAssetOrReserved(slug)) continue

      const rawDay = get('date')
      out.push({
        slug,
        host: normHost(get('x-host-header')) ?? normHost(get('cs(Host)')) ?? 'unknown',
        day: rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : undefined,
        referrerHost: referrerHost(get('cs(Referer)')),
        uaClass: uaClass(get('cs(User-Agent)')),
      })
    } catch {
      // Any per-row error (bad %-encoding, etc.) → skip; never throw out.
      continue
    }
  }

  return out
}
