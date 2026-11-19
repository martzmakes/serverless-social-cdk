// SINGLE SOURCE OF TRUTH for reserved top-level paths. The CloudFront Function
// (longform-edge.js) hardcodes the SAME list — keep them in lockstep; the
// stack test asserts longform-edge.js contains every prefix in this set.
export const RESERVED_PREFIXES = new Set<string>([
  'xrpc', 'oauth', '.well-known', 'mcp', 'ap', 'auth', 'profile', 'settings',
  'longform', 'compose', 'assets', '_expo', 'static', 'notifications',
  'search', 'docs', 'following',
])
const RESERVED_FILES = new Set<string>(['', 'index.html', 'sitemap.xml', 'rss.xml', 'atom.xml', 'robots.txt', 'og-default.png', 'manifest.json', 'sw.js', 'icon-512.png'])

export function isReserved(path: string): boolean {
  const seg = path.replace(/^\/+/, '').split('/')[0].split('?')[0]
  if (RESERVED_FILES.has(seg)) return true
  if (seg.startsWith('favicon')) return true
  return RESERVED_PREFIXES.has(seg)
}

// NOTE: NO length cap. Spec #5b decision #2 (slug PARITY) requires an explicit
// record slug to be served VERBATIM at <host>/<slug> so existing inbound /
// Hashnode backlinks don't 404. ~15 of the migrated posts have slugs >64 chars;
// the prior `.slice(0,64)` truncated those at render/serve and broke parity.
// Already-valid slugs ([a-z0-9-], lowercase) pass through this normalize chain
// unchanged; the lowercase/ASCII/whitespace passes still neutralize a genuinely
// malformed slug, and the reserved-suffix guard still prevents shadowing an app
// route. S3 keys (max 1024), CloudFront paths and the DDB sk all tolerate long
// slugs, and longform-edge.js imposes no length cap — so the served path now
// equals the record/original slug end-to-end.
export function safeSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-') || 'post'
  return (RESERVED_PREFIXES.has(base) || RESERVED_FILES.has(base) || base.startsWith('favicon')) ? `${base}-post` : base
}

export type EdgeDecision =
  | { kind: 'passthrough' }
  | { kind: 'rewrite'; uri: string }
  | { kind: 'redirect'; status: 301; location: string }
  | { kind: 'gone'; status: 410 }

/** Pure mirror of the CloudFront Function logic — kvGet returns the KVS value or undefined. */
export function decideEdge(path: string, kvGet: (slug: string) => string | undefined): EdgeDecision {
  if (isReserved(path)) return { kind: 'passthrough' }
  const slug = path.replace(/^\/+/, '').replace(/\/+$/, '').split('?')[0]
  if (!slug) return { kind: 'passthrough' }
  const v = kvGet(slug)
  if (v === '410') return { kind: 'gone', status: 410 }
  if (v && v.startsWith('301 ')) return { kind: 'redirect', status: 301, location: v.slice(4) }
  return { kind: 'rewrite', uri: `/${slug}/index.html` }
}
