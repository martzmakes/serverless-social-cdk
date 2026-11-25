import { Marked, Renderer } from 'marked'
import hljsCore from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import python from 'highlight.js/lib/languages/python'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import { sanitizeWithProfile, attr, type SanitizeProfile } from '../ap/sanitize'
import { canonicalApHost } from '../ap/host'
import { absoluteImageUrl, shareImageTags, type CoverPreview } from './longform-preview'
import { normalizeVideoCompanion, type VideoCompanion } from '../../../youtube'

export interface LongformContent {
  title: string
  content: string
  slug: string
  createdAt: string
  excerpt?: string
  tags?: string[]
  originalUrl?: string
  /** Published cover image URL and optional author-provided description. */
  coverImage?: string
  coverImageAlt?: string
  video?: VideoCompanion
  managedLaunch?: boolean
  /**
   * Spec #5d Task 10: when the longform was syndicated to Bluesky as a short
   * post, the renderer emits an inline comments widget (read-only) that
   * fetches the adjoining thread from the public AppView and renders replies
   * inline. Apex byte-lock: when `syndication?.bsky?.uri` is absent, the
   * renderer emits ZERO additional bytes — no `<section id="comments">`,
   * no widget `<script>`, no widget CSS.
   */
  syndication?: { bsky?: { uri: string; cid?: string } }
  /**
   * Spec #5d Task 10: handle used to build the SPA reply-CTA href
   * (`${origin}/profile/${authorHandle}/post/${rkey}`). Only rendered when
   * `syndication?.bsky?.uri` is also set; SAFE_URL-gated; a handle containing
   * `:` (scheme-injection attempt) → CTA omitted (section + widget still render).
   */
  authorHandle?: string
}
export interface RenderCtx {
  origin: string
  siteName: string
  author: string
  articleTimeZone?: string
  /**
   * Edge-rendered article CSS (martzmakes-layout-spec.md): the tenant's
   * resolved brand accent (from `social.serverless.config`), when the caller
   * has it available. Feeds the CTA button fill AND its text-color luminance
   * check (see `onAccentFor`). Omitted / invalid hex → falls back to the
   * platform default accent `#3B82FF` with `#EEF1F6` (light) text, matching
   * the SPA's static default (tokens.ts `colors.accent` / `colors.onAccent`).
   */
  accent?: string
  /**
   * Task 15: the author's `app.bsky.actor.profile` (display name, bio, avatar
   * blob). Optional — the author card still renders (handle only) without it.
   */
  profile?: AuthorProfile
  /** Task 15: up to 3 related posts (see `pickRelated`). Omitted/empty → no section. */
  related?: RelatedPost[]
  coverPreview?: CoverPreview
  /** Task 15: AP_CUSTOM_HOSTS allowlist, used for the Mastodon handle
   *  (`@user@canonicalApHost`). Omitted → every tenant is apex-hosted. */
  apCustomHosts?: string[]
}

/** Subset of the AT profile record the author card needs. `did` + `avatarCid`
 *  build the getBlob URL against `ctx.origin`. */
export interface AuthorProfile {
  displayName?: string
  description?: string
  avatarCid?: string
  did?: string
}

export interface RelatedPost {
  slug: string
  title: string
  createdAt: string
}

/** Structural subset of longform-index.ts IndexItem (no import: keeps render pure). */
export interface RelatedCandidate {
  rkey: string
  currentSlug: string
  status: string
  title: string
  tags: string[]
  createdAt: string
}

const htmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const VIDEO_COMPANION_CSS = `
.video-companion{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;
  gap:12px 24px;margin:32px 0;padding:16px 20px;border:1px solid currentColor;
  border-color:color-mix(in srgb,currentColor 24%,transparent);border-radius:12px;
  background:color-mix(in srgb,currentColor 4%,transparent)}
.video-companion__label{display:block;font-size:.82rem;line-height:1.4}
.video-companion__title{display:block;margin-top:.25rem;overflow-wrap:anywhere}
.video-companion a{display:inline-flex;align-items:center;gap:.35em;min-height:44px;font-weight:600}
.video-companion a:focus-visible{outline:2px solid currentColor;outline-offset:4px;border-radius:2px}
`

export function renderVideoCompanion(input: unknown): string {
  const video = normalizeVideoCompanion(input)
  if (!video) return ''
  return `<aside class="video-companion" aria-label="Video companion">
<div><span class="video-companion__label">Video companion</span>${video.title ? `<strong class="video-companion__title">${htmlEscape(video.title)}</strong>` : ''}</div>
<a href="${htmlEscape(video.url)}" target="_blank" rel="noopener noreferrer" aria-label="Watch on YouTube (opens in a new tab)">Watch on YouTube <span aria-hidden="true">↗</span></a>
</aside>`
}

// ─── Accent + read-time helpers (martzmakes-layout-spec.md) ──────────────────

const DEFAULT_ACCENT = '#3B82FF'
const DARK_TEXT = '#07090C'
const LIGHT_TEXT = '#FFFFFF'

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function srgbChannel(c: number): number {
  const cs = c / 255
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b)
}

/** Resolve { accent, onAccent } for every accent-filled button on the page
 *  (comments CTA, author-card follow button), given an optional tenant accent
 *  hex. Invalid/absent hex → the platform default accent. The text colour is
 *  whichever of dark / white has the higher WCAG contrast on the fill: the
 *  default #3B82FF gets dark text (6.6:1) because white only reaches 3.2:1.
 *  The SPA's BrandConfigContext still picks by a 0.4 luminance threshold, so
 *  its buttons can differ from the edge render on mid-luminance accents. */
function resolveAccentPair(accent: string | undefined): { accent: string; onAccent: string } {
  const rgb = accent ? hexToRgb(accent) : null
  const fill = rgb ? (accent as string) : DEFAULT_ACCENT
  const { r, g, b } = rgb ?? hexToRgb(DEFAULT_ACCENT)!
  const L = relativeLuminance(r, g, b)
  // contrast(dark #07090C, L≈0.003) vs contrast(white, L=1)
  const onAccent = (L + 0.05) / 0.053 >= 1.05 / (L + 0.05) ? DARK_TEXT : LIGHT_TEXT
  return { accent: fill, onAccent }
}

const READ_WPM = 230

/** Word-count-based read-time estimate — mirrors app/src/lib/readTime.ts
 *  (countWords + readTimeFromWordCount at the default 230wpm) so the edge
 *  render and the SPA agree on the same article's read time. */
function readTimeLabel(text: string): string {
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
  if (words <= 0) return '1 min'
  return `${Math.max(1, Math.round(words / READ_WPM))} min`
}

/** Escape a JSON string for safe embedding in <script type="application/ld+json">.
 *  JSON.stringify does NOT escape < > & or Unicode line terminators U+2028/U+2029 —
 *  any of these in author-controlled strings can break out of the script block.
 */
const jsonLdSafe = (s: string) =>
  s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')

const SAFE_URL = /^(https?:|mailto:|\/)/i

// ─── Frontmatter stripping (validation-2026-09-02) ────────────────────────────
//
// Ported byte-identically from app/src/components/Markdown.tsx's
// `stripFrontmatter` / `stripDuplicatedInBodyFrontmatter` — infra is a
// separate TS project from app/ (no shared import), so this is a deliberate
// hand-kept duplicate. Keep the two in sync by hand; longform-frontmatter
// behavior is covered by tests in BOTH app/test and infra/test/pds using the
// same real "Are You a Jerk?" fixture.

/** Bare `key:` header lines stripped when they appear at the top of the body
 *  with no `---` fence at all (some importers omit the fence entirely). */
const FRONTMATTER_KEY_RE = /^(title|published|date|tags|canonical_url)\s*:/i

/** Keys recognized inside a duplicated-in-body frontmatter block (pass 0) —
 *  a superset of FRONTMATTER_KEY_RE's keys, since the in-body block can also
 *  carry Hashnode-style `cover_image` / `description` / `slug` / `series`. */
const DUP_BLOCK_KEYS = [
  'title',
  'published',
  'date',
  'tags',
  'canonical_url',
  'cover_image',
  'description',
  'slug',
  'series',
]
const DUP_KEY_ALT = DUP_BLOCK_KEYS.join('|')
const DUP_KEY_START_RE = new RegExp(`^(?:${DUP_KEY_ALT})\\s*:`, 'i')
const DUP_KEY_SPLIT_RE = new RegExp(`(?=\\b(?:${DUP_KEY_ALT})\\s*:)`, 'gi')
const DUP_ITALIC_TITLE_RE = /^[*_]?title:\s*.+[*_]?$/i
const DUP_BLOCK_MAX_SCAN = 25

/** True when `text` (interior lines of a candidate frontmatter block, joined
 *  with newlines) consists ONLY of recognized `key: value` pairs — whether
 *  one per line, or all joined onto a single paragraph line. */
function isPureKeyValueBlock(text: string): boolean {
  const joined = text.replace(/\n+/g, ' ').trim()
  if (!joined) return false
  if (!DUP_KEY_START_RE.test(joined)) return false
  const tokens = joined
    .split(DUP_KEY_SPLIT_RE)
    .map((t) => t.trim())
    .filter(Boolean)
  return tokens.length > 0 && tokens.every((t) => DUP_KEY_START_RE.test(t))
}

/** Pass 0 — removes a duplicated Hashnode-style frontmatter block that some
 *  imports carry INSIDE the body, ahead of the real content (see
 *  Markdown.tsx's doc comment for the full shape). All pieces must match
 *  contiguously from the top or nothing is stripped. `title` omitted → no-op. */
function stripDuplicatedInBodyFrontmatter(markdown: string, title: string | undefined): string {
  if (!title || !title.trim()) return markdown
  const lines = markdown.split('\n')

  let idx = 0
  while (idx < lines.length && lines[idx].trim() === '') idx++
  if (idx >= lines.length) return markdown

  const h1Match = lines[idx].trim().match(/^#\s+(.+)$/)
  if (!h1Match) return markdown
  if (h1Match[1].trim().toLowerCase() !== title.trim().toLowerCase()) return markdown

  let j = idx + 1
  while (j < lines.length && lines[j].trim() === '') j++
  if (j >= lines.length || !DUP_ITALIC_TITLE_RE.test(lines[j].trim())) return markdown

  let k = j + 1
  while (k < lines.length && lines[k].trim() === '') k++
  if (k >= lines.length || lines[k].trim() !== '---') return markdown

  let closeIdx = -1
  for (let m = k + 1; m < lines.length && m <= k + DUP_BLOCK_MAX_SCAN; m++) {
    if (lines[m].trim() === '---') {
      closeIdx = m
      break
    }
  }
  if (closeIdx === -1) return markdown

  const interior = lines.slice(k + 1, closeIdx).join('\n')
  if (!isPureKeyValueBlock(interior)) return markdown

  const rest = lines.slice(closeIdx + 1)
  while (rest.length && rest[0].trim() === '') rest.shift()
  return rest.join('\n')
}

/** stripFrontmatter — see Markdown.tsx's doc comment; byte-identical port. */
export function stripFrontmatter(markdown: string, title?: string): string {
  if (!markdown) return markdown
  const afterDup = stripDuplicatedInBodyFrontmatter(markdown, title)
  const lines = afterDup.split('\n')
  let i = 0

  // Pass 1 — fenced YAML block.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let closeIdx = -1
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') {
        closeIdx = j
        break
      }
    }
    if (closeIdx !== -1) {
      i = closeIdx + 1
    }
  }

  // Pass 2 — leading bare `key:` header lines (fence or no fence).
  while (i < lines.length && (lines[i].trim() === '' || FRONTMATTER_KEY_RE.test(lines[i].trim()))) {
    if (lines[i].trim() === '') {
      const next = lines[i + 1]
      if (next === undefined || !FRONTMATTER_KEY_RE.test(next.trim())) break
    }
    i++
  }

  return lines.slice(i).join('\n').replace(/^\n+/, '')
}

/** validation-2026-09-02: Hashnode-import pseudo-tags that are post-status
 *  metadata, not real author-entered topic tags — filtered from every place
 *  `rec.tags` is read (meta row, JSON-LD keywords). Ported byte-identically
 *  from app/src/components/LongformArticle.tsx's `HASHNODE_PSEUDO_TAGS`. */
const HASHNODE_PSEUDO_TAGS = new Set(['content/blog', 'published'])

/** Real, display-worthy tags for a record — `rec.tags` with Hashnode's
 *  internal post-status labels filtered out. */
function realTags(rec: LongformContent): string[] {
  return (rec.tags || []).filter((t) => !HASHNODE_PSEUDO_TAGS.has(t))
}

/**
 * Task 15: up to `max` OTHER published posts that share at least one real tag
 * with this one, most shared tags first, then newest. Pure: callers pass the
 * index list the renderer already loads for the feeds (no extra read).
 */
export function pickRelated(
  index: RelatedCandidate[],
  self: { rkey?: string; slug: string; tags?: string[] },
  max = 3,
): RelatedPost[] {
  const norm = (t: string) => t.trim().toLowerCase()
  const mine = new Set((self.tags || []).filter((t) => !HASHNODE_PSEUDO_TAGS.has(t)).map(norm).filter(Boolean))
  if (mine.size === 0) return []
  return index
    .filter((i) => i.status === 'published' && i.rkey !== self.rkey && i.currentSlug !== self.slug)
    .map((i) => ({
      i,
      shared: new Set((i.tags || []).filter((t) => !HASHNODE_PSEUDO_TAGS.has(t)).map(norm).filter((t) => mine.has(t))).size,
    }))
    .filter((x) => x.shared > 0)
    .sort((a, b) =>
      b.shared - a.shared ||
      (a.i.createdAt < b.i.createdAt ? 1 : a.i.createdAt > b.i.createdAt ? -1 : 0) ||
      (a.i.currentSlug < b.i.currentSlug ? -1 : 1))
    .slice(0, max)
    .map((x) => ({ slug: x.i.currentSlug, title: x.i.title, createdAt: x.i.createdAt }))
}

/** `@martzmakes@martzmakes.com` / `@serverless@serverless.social`: first DNS
 *  label of the handle at the tenant's canonical AP host (ap/host.ts). */
export function mastodonHandle(handle: string, customHosts: string[] = []): string {
  return `@${handle.toLowerCase().split('.')[0]}@${canonicalApHost(handle, customHosts)}`
}

// ─── Markdown → safe HTML (Task 13) ──────────────────────────────────────────
//
// marked (CommonMark + GFM) parses; highlight.js core highlights fenced code at
// render time (server side, no client JS); then the HTML is round-tripped
// through ap/sanitize's parse5 allowlist walker, which re-serializes ONLY the
// allowlist. Raw HTML in the source is NOT passed through: marked's `html`
// renderer escapes it, so `<script>` and `Promise<string>` both show as text.
// Names/safety contract unchanged: also used for ActivityPub Article content.

const hljs = hljsCore
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('python', python)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('sql', sql)
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', py: 'python', html: 'xml', svg: 'xml',
}

// Raw tag names that are handed to the sanitizer instead of being escaped. Safety
// does NOT rely on this list: sanitizeWithProfile(POST_PROFILE) is the boundary.
// Raw <img> is deliberately NOT here (longform-render.test.ts pins it as visible
// text): images come from Markdown syntax only.
const RAW_HTML_PASSTHROUGH = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'center', 'cite', 'code', 'del', 'details', 'div', 'em',
  'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'kbd', 'li',
  'mark', 'ol', 'p', 'picture', 'pre', 's', 'section', 'small', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
])

const md = new Marked({ gfm: true, breaks: false })
md.use({
  renderer: {
    // Raw HTML (block or inline). Imported (Hashnode) posts carry presentational
    // HTML: `<a name="x"></a>` anchors, `<figcaption>`, `<br>`, `<div align>`.
    // Showing those as literal text is a regression against the old renderer
    // (which stripped the tags), so a tag from RAW_HTML_PASSTHROUGH goes to the
    // allowlist sanitizer below, which re-serializes ONLY allowed elements and
    // attributes (unknown ones are unwrapped, `<script>`/`<style>` dropped with
    // their content). Anything else (`<string>`, `<T>`, `<script>`) is escaped
    // to visible text. HTML comments are dropped.
    html({ text }) {
      if (/^\s*<!--/.test(text)) return ''
      const m = /^\s*<\/?([A-Za-z][\w:-]*)/.exec(text)
      if (m && RAW_HTML_PASSTHROUGH.has(m[1].toLowerCase())) return text
      return htmlEscape(text).replace(/&quot;/g, '"')
    },
    code({ text, lang }) {
      const word = (lang ?? '').trim().split(/\s+/)[0] ?? ''
      const clean = /^[\w+#-]{1,30}$/.test(word) ? word.toLowerCase() : ''
      // Own-key lookup only: a fence labelled `constructor` or `__proto__` must
      // not resolve to Object.prototype members (a function is not a language
      // name, and hljs.getLanguage would throw on it).
      const hl = Object.prototype.hasOwnProperty.call(LANG_ALIASES, clean) ? LANG_ALIASES[clean] : clean
      if (hl && hljs.getLanguage(hl)) {
        const out = hljs.highlight(text, { language: hl, ignoreIllegals: true }).value
        return `<pre><code class="language-${clean}">${out}</code></pre>\n`
      }
      return `<pre><code>${htmlEscape(text).replace(/&quot;/g, '"')}</code></pre>\n`
    },
    table(token) {
      // Default table renderer, wrapped so wide tables scroll in their own box.
      return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`
    },
  },
})

const CLASS_TOKEN = /^[\w-]{1,40}$/
const safeClass = (v: string | undefined, max = 120): string | undefined => {
  if (!v || v.length > max) return undefined
  return v.split(/\s+/).every((t) => CLASS_TOKEN.test(t)) ? v.trim() : undefined
}
const POST_TAGS = new Set([
  'p', 'br', 'a', 'span', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div',
  'input',
])
const POST_PROFILE: SanitizeProfile = {
  allowed: POST_TAGS,
  voidTags: new Set(['br', 'hr', 'img', 'input']),
  maxChars: 4_000_000,
  compactTags: new Set(['blockquote', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'div']),
  collapseNewlinesExcept: new Set(['pre']),
  attrs(el, tag) {
    switch (tag) {
      case 'a': {
        const href = attr(el, 'href')
        return href && SAFE_URL.test(href) ? [['href', href], ['rel', 'nofollow noopener']] : null
      }
      case 'img': {
        const src = attr(el, 'src')
        if (!src || !SAFE_URL.test(src)) return null
        return [['src', src], ['alt', attr(el, 'alt') ?? ''], ['loading', 'lazy']]
      }
      case 'code': {
        const c = attr(el, 'class')
        return c && /^language-[\w+#-]{1,30}$/.test(c) ? [['class', c]] : []
      }
      case 'span': {
        const c = safeClass(attr(el, 'class'))
        return c && c.startsWith('hljs-') ? [['class', c]] : []
      }
      case 'div':
        return attr(el, 'class') === 'table-wrap' ? [['class', 'table-wrap']] : null
      case 'input': {
        // GFM task-list item only: always disabled, never any other input type.
        if (attr(el, 'type') !== 'checkbox') return null
        const out: [string, string][] = [['type', 'checkbox'], ['disabled', '']]
        if (attr(el, 'checked') !== undefined) out.push(['checked', ''])
        return out
      }
      case 'th':
      case 'td': {
        const al = attr(el, 'align')
        return al && /^(left|center|right)$/.test(al) ? [['align', al]] : []
      }
      default:
        return []
    }
  },
}

export function mdToSafeHtml(source: string): string {
  const html = md.parse(source, { async: false }) as string
  return sanitizeWithProfile(html, POST_PROFILE).trim()
}

const derived = (md: string, n: number): string =>
  md.replace(/[#*`>\-]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ').trim().slice(0, n)

/** "2026-05-01T12:00:00.000Z" → "May 1, 2026" (falls back to the raw ISO
 *  date slice if Intl/Date parsing throws — defensive, mirrors the rest of
 *  this file's crash-guarded formatting helpers). */
function formatDisplayDate(iso: string, articleTimeZone?: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso.slice(0, 10)
    // Imported calendar dates can be stored as midnight UTC. Keep their day.
    const isCalendarDate = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/.test(iso)
    const timeZone = isCalendarDate ? 'UTC' : articleTimeZone ?? 'UTC'
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone })
  } catch {
    return iso.slice(0, 10)
  }
}

/**
 * Build the single wrapping mono metadata row (spec "Edge-rendered article
 * CSS"): date · read time · tags · "originally at <host>" · syndication —
 * middot-separated, every field optional and gracefully omitted. Replaces
 * the previously separate `.meta` / `.tags` / `.origurl` blocks.
 */
function buildMetaRow(rec: LongformContent, strippedContent: string, { origin, articleTimeZone }: RenderCtx): string {
  const items: string[] = []

  items.push(
    `<time datetime="${htmlEscape(rec.createdAt)}">${htmlEscape(formatDisplayDate(rec.createdAt, articleTimeZone))}</time>`,
  )
  items.push(htmlEscape(readTimeLabel(strippedContent)))

  const tags = realTags(rec)
  if (tags.length) {
    // Task 15: each tag links to the SPA search for that hashtag.
    items.push(tags.map((t) =>
      `<a class="tag" href="${htmlEscape(origin)}/search?q=${encodeURIComponent('#' + t)}">#${htmlEscape(t)}</a>`,
    ).join(' '))
  }

  if (rec.originalUrl && SAFE_HREF(rec.originalUrl)) {
    let host = rec.originalUrl
    try {
      host = new URL(rec.originalUrl).hostname || rec.originalUrl
    } catch {
      /* keep the full URL as a fallback display string */
    }
    items.push(
      `originally at <a href="${htmlEscape(rec.originalUrl)}" rel="nofollow noopener">${htmlEscape(host)}</a>`,
    )
  }

  if (!rec.managedLaunch && rec.syndication?.bsky?.uri) {
    items.push('syndicated to bluesky')
  }

  return `<div class="meta-row">${items
    .map((item, i) => (i === 0 ? item : `<span class="mdot" aria-hidden="true">·</span>${item}`))
    .join('')}${rec.managedLaunch ? managedRegion('meta', managedBlueskyMeta(!!rec.syndication?.bsky?.uri)) : ''}</div>`
}

/**
 * Self-contained, zero-JS article shell styled to match the Expo SPA.
 *
 * Why standalone HTML rather than an SPA route: crawlers and social-card
 * scrapers must get a fully server-rendered page with no JS dependency
 * (see docs/longform.md). So we keep the page self-contained but make it
 * visually + navigationally indistinguishable from the app — same brand
 * palette (app/src/theme/tokens.ts), same webfonts the deploy workflow
 * injects into the SPA, and real links back into the SPA routes.
 *
 * `.meta-row` (martzmakes-layout-spec.md "Edge-rendered article CSS"): one
 * wrapping mono row with middot separators — see `buildMetaRow` above —
 * replaces what used to be three stacked blocks (`.meta` date paragraph,
 * `.tags` pill list, and a standalone "originally published at …" paragraph).
 */
const BRAND_CSS = `
:root{color-scheme: dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#07090C;color:#B8C0CC;
  font-family:'General Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  font-size:17px;line-height:1.75;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:rgba(59,130,255,0.32);color:#EEF1F6}
a{color:#3B82FF;text-decoration:none}
a:hover{color:#5897FF}
.wrap{max-width:720px;margin:0 auto;padding:0 20px}
.site-header{border-bottom:1px solid rgba(255,255,255,0.06)}
.site-header .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;
  gap:0 16px;min-height:56px}
.brand{color:#EEF1F6;font-weight:600;font-size:16px;letter-spacing:-0.01em}
.brand:hover{color:#EEF1F6}
.site-nav{display:flex;flex-wrap:wrap;align-items:center;margin:0 -10px}
.site-nav a{color:#B8C0CC;font-size:15px;line-height:20px;padding:12px 10px;display:inline-block}
.site-nav a:hover{color:#EEF1F6}
.eyebrow{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#8892A0}
a:focus-visible,summary:focus-visible{outline:2px solid #5897FF;outline-offset:3px;border-radius:3px}
main{padding:56px 0 40px}
article{overflow-wrap:break-word}
article h1{color:#EEF1F6;font-weight:600;font-size:clamp(28px,6vw,44px);
  line-height:1.14;letter-spacing:-0.7px;margin:0 0 16px}
article h2{color:#EEF1F6;font-weight:600;font-size:20px;line-height:28px;
  letter-spacing:-0.01em;margin:32px 0 8px}
article h3{color:#EEF1F6;font-weight:600;font-size:17px;line-height:24px;margin:28px 0 8px}
article h4{color:#EEF1F6;font-weight:600;font-size:15px;line-height:22px;margin:24px 0 8px}
article p{margin:0 0 20px;color:#EEF1F6;font-size:17px;line-height:30px}
article strong{color:#EEF1F6;font-weight:600}
article a{text-decoration:underline;text-underline-offset:2px;
  text-decoration-color:rgba(59,130,255,0.4)}
.meta-row{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;color:#8892A0;display:flex;flex-wrap:wrap;align-items:center;
  gap:6px 10px;margin:0 0 32px}
.meta-row a{color:#8892A0;text-decoration:underline;text-underline-offset:2px}
.meta-row a:hover{color:#EEF1F6}
.meta-row .mdot{color:#8892A0}
.meta-row .tag{display:inline-block;padding:4px 2px}
blockquote{margin:0 0 20px;padding-left:16px;border-left:1px solid rgba(255,255,255,0.16);
  color:#B8C0CC;font-size:17px;line-height:30px}
blockquote p{margin:0}
code{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:0.88em;background:#11151C;color:#EEF1F6;
  border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:1px 5px}
pre{background:#11151C;border:1px solid rgba(255,255,255,0.10);border-radius:8px;
  padding:16px;overflow-x:auto;max-width:100%;margin:0 0 24px}
pre code{background:none;border:0;padding:0;font-size:13px;line-height:22px;
  color:#B8C0CC;white-space:pre}
article img{max-width:100%;height:auto;border-radius:8px}
article ul,article ol{margin:0 0 20px;padding-left:24px;color:#EEF1F6;font-size:17px;line-height:30px}
article li{margin:0 0 4px}
article li>ul,article li>ol{margin:4px 0 0}
article li>input[type=checkbox]{margin:0 8px 0 0;vertical-align:middle;accent-color:#3B82FF}
article hr{border:0;border-top:1px solid rgba(255,255,255,0.10);margin:32px 0}
article del{color:#8892A0}
.table-wrap{overflow-x:auto;max-width:100%;margin:0 0 24px}
.table-wrap table{border-collapse:collapse;font-size:15px;line-height:24px}
.table-wrap th,.table-wrap td{border:1px solid rgba(255,255,255,0.10);padding:8px 12px;text-align:left;
  vertical-align:top}
.table-wrap th{color:#EEF1F6;font-weight:600;background:#11151C}
.table-wrap [align=center]{text-align:center}
.table-wrap [align=right]{text-align:right}
.hljs-comment,.hljs-quote{color:#7C8696;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-meta .hljs-keyword{color:#5897FF}
.hljs-string,.hljs-regexp,.hljs-attr,.hljs-template-variable{color:#EEF1F6}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable,.hljs-built_in,.hljs-type{color:#8892A0}
.hljs-title,.hljs-section,.hljs-name,.hljs-selector-class,.hljs-selector-id{color:#3B82FF}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}
.site-footer{border-top:1px solid rgba(255,255,255,0.06);margin-top:56px;
  padding:28px 0 56px}
.site-footer .wrap{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:center;
  font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;color:#8892A0}
.site-footer a{color:#8892A0}
.site-footer a:hover{color:#EEF1F6}
.author-card{margin:48px 0 0;padding:20px;background:#0D1117;
  border:1px solid rgba(255,255,255,0.10);border-radius:12px;display:flex;gap:16px;align-items:flex-start}
.author-avatar{width:56px;height:56px;border-radius:50%;flex:none;object-fit:cover;background:#11151C;
  display:flex;align-items:center;justify-content:center;color:#EEF1F6;font-weight:600;font-size:22px}
.author-body{min-width:0;flex:1}
.author-name{color:#EEF1F6;font-weight:600;font-size:18px;line-height:26px;margin:0}
.author-handle{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;color:#8892A0;margin:0}
.author-bio{margin:8px 0 0;font-size:15px;line-height:24px;color:#B8C0CC}
.follow-links{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;
  border-radius:8px;font-size:15px;font-weight:600;line-height:20px;text-decoration:none}
.btn-pill{border:1px solid rgba(255,255,255,0.24);color:#EEF1F6}
.btn-pill:hover{color:#EEF1F6;background:rgba(255,255,255,0.06)}
.fedi{font-size:13px;color:#8892A0;margin:14px 0 0;line-height:22px}
.fedi code{font-size:13px;word-break:break-all}
.related{margin:40px 0 0}
.related h2{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  letter-spacing:1px;text-transform:uppercase;color:#8892A0;font-weight:500;margin:0 0 4px}
.related ul{list-style:none;margin:0;padding:0;border-top:1px solid rgba(255,255,255,0.06)}
.related li{margin:0;border-bottom:1px solid rgba(255,255,255,0.06)}
.related a{display:block;padding:14px 0;color:#EEF1F6;font-size:17px;line-height:26px;font-weight:600;text-decoration:none}
.related a:hover{color:#5897FF}
.related time{display:block;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;font-weight:400;color:#8892A0}
@media(max-width:640px){main{padding:32px 0}
  .site-header .wrap{padding-top:4px}
  .author-card{flex-direction:column}
  .follow-links .btn{flex:1 1 auto}}
`.replace(/\n\s*/g, '')

const SAFE_HREF = (u: string): boolean => SAFE_URL.test(u)

/** Spec #5d Task 10: comments widget styles. Emitted ONLY when the article
 *  has a syndicated Bluesky thread (i.e. `syndication?.bsky?.uri`). Apex
 *  byte-lock: a non-syndicated render emits ZERO of these bytes. */
const COMMENTS_CSS = `
#comments{margin-top:48px;padding-top:32px;border-top:1px solid rgba(255,255,255,0.10)}
.comments-heading{color:#EEF1F6;font-weight:600;font-size:22px;margin:0 0 18px}
#comments-list[data-state="loading"]{color:#8892A0;font-style:italic;position:relative;padding-left:18px}
#comments-list[data-state="loading"]::before{content:"";position:absolute;left:0;top:50%;width:8px;height:8px;border-radius:50%;background:#3B82FF;transform:translateY(-50%);animation:mm-comments-pulse 1.2s ease-in-out infinite}
@keyframes mm-comments-pulse{0%,100%{opacity:.25}50%{opacity:1}}
#comments-list[data-state="empty"]{color:#B8C0CC;font-size:15px;text-align:center;padding:18px 0}
#comments-list[data-state="error"]{color:#B8C0CC;font-size:14px;text-align:center;padding:14px 0}
.comment{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06)}
.comment:last-child{border-bottom:0}
.comment-avatar{flex:0 0 36px;width:36px;height:36px;border-radius:50%;background:#11151C;object-fit:cover}
.comment-avatar-placeholder{flex:0 0 36px;width:36px;height:36px;border-radius:50%;background:#11151C;border:1px solid rgba(255,255,255,0.06)}
.comment-body{flex:1 1 auto;min-width:0}
.comment-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#8892A0;margin:0 0 4px}
.comment-author{color:#EEF1F6;font-weight:600;font-family:'General Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px}
.comment-handle{color:#8892A0}
.comment-time{color:#8892A0}
.comment-text{margin:0;color:#B8C0CC;font-size:15px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}
.comment-text a{color:#3B82FF;text-decoration:underline;text-underline-offset:2px}
.comment-replies{margin-top:10px;padding-left:14px;border-left:2px solid rgba(255,255,255,0.06)}
.comments-cta{margin-top:22px;text-align:center}
.comments-cta a{display:inline-block;padding:10px 18px;text-decoration:none;border-radius:6px;font-weight:600;font-family:'General Sans',ui-sans-serif,system-ui;font-size:14px;opacity:1}
.comments-cta a:hover{opacity:0.88}
`.replace(/\n\s*/g, '')

/** Spec #5d Task 10: inline vanilla-JS comments widget. Embedded as a single
 *  <script>…</script> at the bottom of the article body when the post is
 *  syndicated. Dependency-free (native fetch + DOM only). All user-derived
 *  strings go through textContent (never innerHTML); URLs are SAFE_URL-gated.
 *  Inline-port of a minimal byte-offset facet splitter for link rendering
 *  (the AppView provides facets — when present we honor byteStart/byteEnd
 *  using TextEncoder for correct UTF-8 indexing). */
const COMMENTS_WIDGET_JS = `(function(){
  var SAFE = /^(https?:|\\/)/i;
  function safeUrl(u){ return typeof u==='string' && SAFE.test(u) ? u : null; }
  function txt(node, s){ node.appendChild(document.createTextNode(String(s==null?'':s))); }
  function el(tag, cls){ var e=document.createElement(tag); if(cls) e.className=cls; return e; }
  function relTime(iso){
    try {
      var t = new Date(iso).getTime();
      if (!isFinite(t)) return '';
      var s = Math.max(1, Math.floor((Date.now()-t)/1000));
      if (s<60) return s+'s';
      var m = Math.floor(s/60); if (m<60) return m+'m';
      var h = Math.floor(m/60); if (h<24) return h+'h';
      var d = Math.floor(h/24); if (d<30) return d+'d';
      var mo = Math.floor(d/30); if (mo<12) return mo+'mo';
      return Math.floor(d/365)+'y';
    } catch(_) { return ''; }
  }
  // UTF-8 byte-offset facet splitter — mirrors T1's splitFacets for inline use.
  // Facets carry byteStart/byteEnd against a UTF-8 encoding of the text; we
  // walk the encoded buffer, decoding slices, so a multi-byte char (emoji)
  // never splits inside.
  function renderTextWithFacets(target, text, facets){
    if (!text) return;
    if (!facets || !facets.length) { txt(target, text); return; }
    var enc, bytes;
    try { enc = new TextEncoder(); bytes = enc.encode(text); }
    catch(_) { txt(target, text); return; }
    var dec = new TextDecoder('utf-8');
    // Collect link facets, sort by byteStart, drop overlaps.
    var links = [];
    for (var i=0;i<facets.length;i++){
      var f = facets[i];
      if (!f || typeof f.byteStart !== 'number' || typeof f.byteEnd !== 'number') continue;
      if (f.byteStart < 0 || f.byteEnd <= f.byteStart || f.byteEnd > bytes.length) continue;
      var uri = null;
      var feats = f.features || [];
      for (var j=0;j<feats.length;j++){
        var ft = feats[j];
        if (ft && ft.$type === 'app.bsky.richtext.facet#link' && typeof ft.uri === 'string') {
          uri = safeUrl(ft.uri); break;
        }
      }
      if (uri) links.push({ s:f.byteStart, e:f.byteEnd, u:uri });
    }
    links.sort(function(a,b){ return a.s - b.s; });
    var nonOverlap = [];
    var last = 0;
    for (var k=0;k<links.length;k++){
      if (links[k].s >= last) { nonOverlap.push(links[k]); last = links[k].e; }
    }
    var cursor = 0;
    for (var n=0;n<nonOverlap.length;n++){
      var L = nonOverlap[n];
      if (L.s > cursor) txt(target, dec.decode(bytes.slice(cursor, L.s)));
      var a = el('a');
      a.setAttribute('href', L.u);
      a.setAttribute('rel', 'nofollow noopener');
      a.setAttribute('target', '_blank');
      txt(a, dec.decode(bytes.slice(L.s, L.e)));
      target.appendChild(a);
      cursor = L.e;
    }
    if (cursor < bytes.length) txt(target, dec.decode(bytes.slice(cursor)));
  }
  function renderPost(parent, post, depth){
    if (!post || !post.record) return;
    var rec = post.record;
    var author = post.author || {};
    var row = el('div', 'comment');
    var avatarUrl = safeUrl(author.avatar);
    if (avatarUrl) {
      var im = el('img', 'comment-avatar');
      im.setAttribute('src', avatarUrl);
      im.setAttribute('alt', '');
      im.setAttribute('loading', 'lazy');
      row.appendChild(im);
    } else {
      row.appendChild(el('div', 'comment-avatar-placeholder'));
    }
    var body = el('div', 'comment-body');
    var meta = el('p', 'comment-meta');
    var nameSpan = el('span', 'comment-author');
    txt(nameSpan, author.displayName || author.handle || 'anon');
    meta.appendChild(nameSpan);
    if (author.handle) {
      var hSpan = el('span', 'comment-handle');
      txt(hSpan, '@' + author.handle);
      meta.appendChild(hSpan);
    }
    var when = relTime(rec.createdAt);
    if (when) {
      var tSpan = el('span', 'comment-time');
      txt(tSpan, when);
      meta.appendChild(tSpan);
    }
    body.appendChild(meta);
    var p = el('p', 'comment-text');
    renderTextWithFacets(p, rec.text || '', rec.facets || []);
    body.appendChild(p);
    row.appendChild(body);
    parent.appendChild(row);
  }
  function walkReplies(target, replies, depth, max){
    if (!replies || !replies.length || depth > 2) return;
    for (var i=0;i<replies.length && max.n < 50; i++){
      var r = replies[i];
      if (!r || !r.post) continue;
      max.n++;
      renderPost(target, r.post, depth);
      if (r.replies && r.replies.length && depth < 1) {
        var nest = el('div', 'comment-replies');
        target.appendChild(nest);
        walkReplies(nest, r.replies, depth+1, max);
      }
    }
  }
  function emptyState(list){
    list.setAttribute('data-state', 'empty');
    while (list.firstChild) list.removeChild(list.firstChild);
    var p = el('p');
    txt(p, 'No comments yet — be the first to comment.');
    list.appendChild(p);
  }
  function errorState(list){
    list.setAttribute('data-state', 'error');
    while (list.firstChild) list.removeChild(list.firstChild);
    var p = el('p');
    txt(p, 'Comments are temporarily unavailable.');
    list.appendChild(p);
  }
  function init(){
    var section = document.getElementById('comments');
    if (!section) return;
    var list = document.getElementById('comments-list');
    if (!list) return;
    var threadUri = section.getAttribute('data-thread-uri');
    var appview = safeUrl(section.getAttribute('data-public-appview'));
    if (!threadUri || !appview) { emptyState(list); return; }
    var url = appview.replace(/\\/+$/, '') + '/xrpc/app.bsky.feed.getPostThread?uri='
      + encodeURIComponent(threadUri) + '&depth=4';
    fetch(url, { credentials: 'omit' })
      .then(function(r){ if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function(data){
        var thread = data && data.thread;
        if (!thread || !thread.post) { emptyState(list); return; }
        var replies = thread.replies || [];
        if (!replies.length) { emptyState(list); return; }
        list.setAttribute('data-state', 'ready');
        while (list.firstChild) list.removeChild(list.firstChild);
        walkReplies(list, replies, 0, { n: 0 });
      })
      .catch(function(){ errorState(list); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`
  // Strip // line comments FIRST — otherwise the subsequent newline-collapse
  // turns each `// comment` into a tail comment that swallows the rest of the
  // script (SyntaxError → widget never executes → permanent "Loading
  // comments…" on the live site). This bug was caught by T10's jsdom invariant.
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\n\s*/g, '')

/** Spec #5d Task 10: extract the rkey (last `/`-segment) from an at-uri.
 *  e.g. `at://did:plc:abc/app.bsky.feed.post/3xyz` → `3xyz`. Returns the
 *  empty string for inputs that don't match the at-uri shape. */
const atUriRkey = (uri: string): string => {
  const m = uri.match(/\/([^\/]+)$/)
  return m ? m[1] : ''
}

/** Spec #5d Task 10: build the comments section HTML when a syndication target
 *  exists. Returns the empty string otherwise — the apex byte-lock requires
 *  the non-syndicated render to be byte-identical. */
function renderCommentsSection(rec: Pick<LongformContent, 'syndication' | 'authorHandle'>, ctx: RenderCtx): string {
  const syn = rec.syndication?.bsky
  if (!syn || !syn.uri) return ''
  const threadUri = htmlEscape(syn.uri)
  const threadCid = htmlEscape(syn.cid ?? '')
  const safeOrigin = htmlEscape(ctx.origin)
  const siteName = htmlEscape(ctx.siteName)
  // Build the SPA reply-CTA href. Two-stage gate:
  //  1) authorHandle present + free of `:` (no scheme-injection attempt) +
  //     free of `/` `?` `#` `"` `<` `>` `&` (path/attribute breakouts);
  //  2) the assembled URL passes SAFE_URL (starts with https:// or /).
  // Either gate failing → CTA omitted; the section + widget still render so
  // readers see comments + the empty/error states.
  let ctaHtml = ''
  const handle = rec.authorHandle
  const rkey = atUriRkey(syn.uri)
  if (handle && rkey && !/[:\/?#"<>&\s]/.test(handle) && !/[:\/?#"<>&\s]/.test(rkey)) {
    const candidate = `${ctx.origin}/profile/${handle}/post/${rkey}`
    if (SAFE_URL.test(candidate)) {
      const safeHref = htmlEscape(candidate)
      // Edge-rendered article CSS: fill from the resolved tenant accent (falls
      // back to the platform default), text colour by WCAG contrast — the same
      // pair the author-card follow button uses — injected inline since the
      // accent varies per-tenant/per-render, not something a static CSS class
      // can express.
      const { accent, onAccent } = resolveAccentPair(ctx.accent)
      const ctaStyle = `background:${htmlEscape(accent)};color:${htmlEscape(onAccent)}`
      ctaHtml = `<p class="comments-cta"><a href="${safeHref}" target="_self" style="${ctaStyle}">Reply on ${siteName}</a></p>`
    }
  }
  return `<section id="comments" aria-label="Comments" data-thread-uri="${threadUri}" data-thread-cid="${threadCid}" data-spa-origin="${safeOrigin}" data-public-appview="https://public.api.bsky.app">
<style>${COMMENTS_CSS}</style>
<h2 class="comments-heading">Comments</h2>
<div id="comments-list" data-state="loading">Loading comments…</div>
${ctaHtml}
<script>${COMMENTS_WIDGET_JS}</script>
</section>`
}



function managedRegion(name: 'comments' | 'meta', html: string) {
  return `<!-- ss:launch-${name}:start -->${html}<!-- ss:launch-${name}:end -->`
}

function managedBlueskyMeta(linked: boolean) {
  return linked ? '<span class="mdot" aria-hidden="true">·</span>syndicated to bluesky' : ''
}

/** Replace only the renderer-owned mounts within a managed article. */
export function patchManagedBluesky(html: string, bsky: NonNullable<NonNullable<LongformContent['syndication']>['bsky']>, ctx: RenderCtx): string {
  const meta = /<!-- ss:launch-meta:start -->[\s\S]*?<!-- ss:launch-meta:end -->/
  const comments = /<!-- ss:launch-comments:start -->[\s\S]*?<!-- ss:launch-comments:end -->/
  if (!meta.test(html) || !comments.test(html)) throw new Error('Managed article mounts are unavailable')
  return html
    .replace(meta, () => managedRegion('meta', managedBlueskyMeta(true)))
    .replace(comments, () => managedRegion('comments', renderCommentsSection({ syndication: { bsky }, authorHandle: ctx.author }, ctx)))
}

/** Task 15: author card (profile + follow links) and related posts. */
function renderEndMatter(rec: LongformContent, ctx: RenderCtx): string {
  const origin = htmlEscape(ctx.origin)
  const handle = ctx.author
  const p = ctx.profile
  const name = (p?.displayName && p.displayName.trim()) || handle
  const bio = p?.description ? p.description.replace(/\s+/g, ' ').trim().slice(0, 280) : ''
  const avatarUrl = p?.avatarCid && p.did
    ? `${ctx.origin}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(p.did)}&cid=${encodeURIComponent(p.avatarCid)}`
    : ''
  const avatar = avatarUrl && SAFE_URL.test(avatarUrl)
    ? `<img class="author-avatar" src="${htmlEscape(avatarUrl)}" alt="" width="56" height="56" loading="lazy">`
    : `<span class="author-avatar" aria-hidden="true">${htmlEscape([...name][0]?.toUpperCase() ?? '?')}</span>`
  // Same { accent, onAccent } pair as the comments CTA, so both buttons agree.
  const { accent, onAccent } = resolveAccentPair(ctx.accent)
  const btnStyle = `background:${htmlEscape(accent)};color:${htmlEscape(onAccent)}`
  const bsky = `https://bsky.app/profile/${encodeURIComponent(handle)}`
  const fedi = mastodonHandle(handle, ctx.apCustomHosts)
  const card = `<section class="author-card" aria-label="About the author">
${avatar}
<div class="author-body">
<p class="author-name">${htmlEscape(name)}</p>
${name !== handle ? `<p class="author-handle">@${htmlEscape(handle)}</p>\n` : ''}${bio ? `<p class="author-bio">${htmlEscape(bio)}</p>\n` : ''}<div class="follow-links">
<a class="btn" style="${btnStyle}" href="${htmlEscape(bsky)}" rel="noopener">Follow on Bluesky</a>
<a class="btn btn-pill" href="${origin}/rss.xml">RSS</a>
</div>
<p class="fedi">Mastodon: <code>${htmlEscape(fedi)}</code></p>
</div>
</section>`
  const rel = (ctx.related || []).slice(0, 3)
  const related = rel.length
    ? `\n<section class="related" aria-labelledby="related-h"><h2 id="related-h">Keep reading</h2><ul>${rel.map((r) =>
        `<li><a href="${origin}/${encodeURIComponent(r.slug)}">${htmlEscape(r.title)}<time datetime="${htmlEscape(r.createdAt)}">${htmlEscape(formatDisplayDate(r.createdAt, ctx.articleTimeZone))}</time></a></li>`,
      ).join('')}</ul></section>`
    : ''
  return `${card}${related}`
}

/** Prefer the cover description, then the alt text of that same image in the article. */
export function coverAltText(value: unknown, markdown: string, cover: string, origin: string): string {
  let alt = typeof value === 'string' ? value.trim() : ''
  if (!alt) {
    md.walkTokens(md.lexer(markdown), token => {
      if (!alt && token.type === 'image' && absoluteImageUrl(token.href, origin) === cover) alt = token.text
    })
  }
  return alt
}

export function renderArticleHtml(rec: LongformContent, ctx: RenderCtx): string {
  const url = `${ctx.origin}/${rec.slug}`
  const cover = absoluteImageUrl(rec.coverImage, ctx.origin)
  const preview = cover ? ctx.coverPreview : undefined
  const strippedContent = stripFrontmatter(rec.content, rec.title)
  const alt = cover ? coverAltText(rec.coverImageAlt, strippedContent, cover, ctx.origin) : undefined
  const img = preview?.url ?? cover ?? `${ctx.origin}/og-default.png`
  const imageTags = shareImageTags({ url: img, preview, alt: cover ? alt : undefined, isCover: !!cover })
  const desc = (rec.excerpt && rec.excerpt.trim()) || derived(strippedContent, 160)
  const title = `${rec.title} — ${ctx.siteName}`
  const siteName = htmlEscape(ctx.siteName)
  // Escape deploy-controlled ctx.origin for HTML-attribute contexts, mirroring
  // siteName. JSON-LD keeps the raw `url` (it has its own jsonLdSafe encoder).
  const safeOrigin = htmlEscape(ctx.origin)
  const safeUrl = htmlEscape(url)
  const profileHref = `${safeOrigin}/profile/${encodeURIComponent(ctx.author)}`
  const metaRowHtml = buildMetaRow(rec, strippedContent, ctx)
  const endMatter = renderEndMatter(rec, ctx)
  const videoHtml = renderVideoCompanion(rec.video)
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: rec.title,
    datePublished: rec.createdAt,
    dateModified: rec.createdAt,
    author: { '@type': 'Person', name: ctx.author },
    publisher: { '@type': 'Organization', name: ctx.siteName },
    mainEntityOfPage: url,
    description: desc,
    ...(cover ? { image: img } : {}),
    keywords: realTags(rec).join(', '),
  })
  // Spec #5d Task 10: comments widget. Returns '' when not syndicated → apex
  // byte-lock: a non-syndicated render is byte-identical to the pre-T10 output.
  const commentsHtml = renderCommentsSection(rec, ctx)
  const commentsBlock = rec.managedLaunch
    ? managedRegion('comments', commentsHtml)
    : commentsHtml ? `\n${commentsHtml}` : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07090C">
<title>${htmlEscape(title)}</title>
<meta name="description" content="${htmlEscape(desc)}">
<link rel="canonical" href="${safeUrl}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${siteName}">
<meta property="og:title" content="${htmlEscape(rec.title)}">
<meta property="og:description" content="${htmlEscape(desc)}">
<meta property="og:url" content="${safeUrl}">
${imageTags.openGraph}
<meta property="article:published_time" content="${htmlEscape(rec.createdAt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${htmlEscape(rec.title)}">
<meta name="twitter:description" content="${htmlEscape(desc)}">
${imageTags.twitter}
<link rel="alternate" type="application/rss+xml" href="${safeOrigin}/rss.xml">
<link rel="icon" href="${safeOrigin}/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&amp;display=swap">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&amp;display=swap">
<style>${BRAND_CSS}${videoHtml ? VIDEO_COMPANION_CSS : ''}</style>
<script type="application/ld+json">${jsonLdSafe(jsonLd)}</script>
</head><body>
<header class="site-header"><div class="wrap">
<a class="brand" href="${safeOrigin}/">${siteName}</a>
<nav class="site-nav" aria-label="Site">
<a href="${safeOrigin}/">Home</a>
<a href="${profileHref}">Writing</a>
<a href="${safeOrigin}/search">Search</a>
<a href="${safeOrigin}/rss.xml">RSS</a>
</nav>
</div></header>
<main><div class="wrap"><article>
<h1>${htmlEscape(rec.title)}</h1>
${metaRowHtml}
${mdToSafeHtml(strippedContent)}${videoHtml ? `\n${videoHtml}` : ''}
${endMatter}
${commentsBlock}
</article></div></main>
<footer class="site-footer"><div class="wrap">
<a href="${safeOrigin}">${siteName}</a>
<a href="${profileHref}">All posts</a>
<a href="${safeOrigin}/rss.xml">RSS</a>
</div></footer>
</body></html>`
}
