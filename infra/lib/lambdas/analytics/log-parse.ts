// Pure CloudFront W3C *standard* access-log parser → longform ViewEvent[].
//
// Pinned to AWS's documented CloudFront standard access-log format: a
// `#Version:` line, a `#Fields:` line listing the tab-separated field order,
// then tab-separated data rows (`-` = empty; cs-uri-stem / cs(Referer) /
// cs(User-Agent) are URL-encoded). Parsing is driven BY the `#Fields:` header
// (name→index map) so AWS field-order drift does not break us.
//
// The rollup input excludes IPs, cookies, full URLs, query strings,
// or any per-user value. Attribution is reduced to fixed source and device groups.
//
// Reserved-path filtering shares the rules used by longform-edge.js.

import { BlockList, isIP } from 'node:net'
import type { Device, Source } from '../../../insights'
import { classifyDevice, classifySource, decodeLogField } from './attribution'
import { edgeLocation } from './edge-locations'
import { isReserved } from '../pds/longform-routing'

/** `article` = /<slug>, `home` = /, `post` = /profile/<actor>/post/<rkey>. */
export type PageKind = 'article' | 'home' | 'post'

export type ViewEvent = {
  kind: PageKind
  /** Article slug, short-post record key, or '' for the home page. */
  slug: string
  /** Short posts only: the profile handle or DID in the path, lowercased. */
  actor?: string
  /** Viewer-facing host (x-host-header, lowercased, `www.` stripped) or 'unknown'. */
  host: string
  /** UTC YYYY-MM-DD from the log row's own `date` field; undefined if absent/malformed. */
  day: string | undefined
  referrerHost: string
  uaClass: 'human' | 'bot'
  source: Source
  device: Device
  /** ISO 3166-1 alpha-2 country of the serving CloudFront edge; `ZZ` if unknown. */
  country: string
  /** Three-letter metro code of the serving CloudFront edge, when logged. */
  edge?: string
}

export type ParseOptions = {
  /**
   * Viewer addresses (IPv4/IPv6, optional /prefix) whose requests are dropped
   * before classification, such as the owner's own network. The address is
   * only compared here and never returned.
   */
  excludeCidrs?: readonly string[]
}

/** Build a matcher for `excludeCidrs`; invalid entries are ignored. */
export function addressFilter(cidrs: readonly string[] = []): (ip: string | undefined) => boolean {
  const list = new BlockList()
  let size = 0
  for (const entry of cidrs) {
    const [address, prefix] = entry.trim().split('/')
    const family = isIP(address)
    if (!family) continue
    const type = family === 4 ? 'ipv4' : 'ipv6'
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix)
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) continue
    list.addSubnet(address, bits, type)
    size++
  }
  if (!size) return () => false
  return (ip) => {
    const family = ip ? isIP(ip) : 0
    return family !== 0 && list.check(ip!, family === 4 ? 'ipv4' : 'ipv6')
  }
}

const RECORD_KEY = /^[A-Za-z0-9._~:-]{1,512}$/
const ACTOR = /^[a-z0-9.:_-]{1,253}$/

const HOST_RE = /^[a-z0-9.-]+$/
/** Normalize a Host header value to a bare lowercase host without `www.`. */
function normHost(raw: string | undefined): string | undefined {
  if (!raw || raw === '-') return undefined
  let h = raw.toLowerCase().trim().replace(/:\d+$/, '')
  if (h.startsWith('www.')) h = h.slice(4)
  return h && HOST_RE.test(h) ? h : undefined
}

function referrerHostname(raw: string | undefined): string | undefined {
  if (!raw || raw === '-') return undefined
  try {
    // Direct URL parsing preserves percent-encoded characters inside the URL.
    // CloudFront can also encode the whole URL field.
    const url = new URL(raw.includes('://') ? raw : decodeLogField(raw))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    const host = normHost(url.hostname.replace(/\.$/, ''))
    return host && host.includes('.') && !isIP(host) ? host : undefined
  } catch {
    return undefined
  }
}

/** Reduce the logged referrer to an approximate registrable domain or "direct". */
export function referrerHost(raw: string | undefined): string {
  return referrerDomain(referrerHostname(raw))
}

function referrerDomain(host: string | undefined): string {
  if (!host) return 'direct'
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
 * (no UA == automated). Every browser, including in-app browsers, sends a UA
 * that starts with `Mozilla/`; anything else (`node`, `curl/…`, share-sheet
 * previewers such as `ActionExtension/2 CFNetwork/…`) is automated. A Mozilla
 * UA with a known crawler/tool token is also a bot.
 */
export function uaClass(raw: string | undefined): 'human' | 'bot' {
  if (raw === undefined || raw === '' || raw === '-') return 'bot'
  let ua = raw
  if (ua.includes('%')) {
    try { ua = decodeURIComponent(ua) } catch { /* keep raw */ }
  }
  ua = ua.trim().toLowerCase()
  if (!ua.startsWith('mozilla/')) return 'bot'
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
    'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptime', 'statuscake', 'preview',
    'discordbot', 'slackbot', 'linkedinbot', 'twitterbot', 'applebot', 'chatgpt', 'gptbot',
    'claudebot', 'claude-user', 'perplexity', 'bytespider', 'amazonbot', 'meta-externalagent',
    'phantomjs', 'puppeteer', 'playwright', 'selenium',
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

/** Map a decoded request path to the page it views, or undefined to skip it. */
export function pageOf(path: string): Pick<ViewEvent, 'kind' | 'slug' | 'actor'> | undefined {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed) return { kind: 'home', slug: '' }
  const parts = trimmed.split('/')
  if (parts.length === 1) return isAssetOrReserved(trimmed) ? undefined : { kind: 'article', slug: trimmed }
  if (parts.length === 4 && parts[0] === 'profile' && parts[2] === 'post') {
    const actor = parts[1].toLowerCase()
    if (ACTOR.test(actor) && RECORD_KEY.test(parts[3])) return { kind: 'post', slug: parts[3], actor }
  }
  return undefined
}

/**
 * Parse a CloudFront standard access-log buffer into page ViewEvents.
 * Header-driven (reads fields by name); skips comments, blank lines, and any
 * malformed/short/erroring row without throwing. Only 200 GET text/html views
 * of the home page, a top-level <slug>, or a short-post page survive. Whether
 * a slug is a real article is checked when the rollups are read.
 */
export function parseCloudFrontLog(buf: Buffer, options: ParseOptions = {}): ViewEvent[] {
  const excluded = addressFilter(options.excludeCidrs)
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
      const page = pageOf(decodeURIComponent(rawUri))
      if (!page) continue
      if (excluded(get('c-ip'))) continue

      const rawDay = get('date')
      const host = normHost(get('x-host-header')) ?? normHost(get('cs(Host)')) ?? 'unknown'
      const referrer = referrerHostname(get('cs(Referer)'))
      const domain = referrerDomain(referrer)
      const agent = get('cs(User-Agent)')
      const location = edgeLocation(get('x-edge-location'))
      out.push({
        ...page,
        host,
        day: rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : undefined,
        referrerHost: domain,
        uaClass: uaClass(agent),
        source: classifySource(get('cs-uri-query'), domain, referrer === host),
        device: classifyDevice(decodeLogField(agent ?? '')),
        country: location?.country ?? 'ZZ',
        ...(location ? { edge: location.edge } : {}),
      })
    } catch {
      // Any per-row error (bad %-encoding, etc.) → skip; never throw out.
      continue
    }
  }

  return out
}
