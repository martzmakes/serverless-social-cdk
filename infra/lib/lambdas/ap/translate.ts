/**
 * ap/translate.ts — pure AT-Proto → ActivityPub content translation
 *
 * No I/O. No side effects. Converts AT-Proto records to AP Note/Article shapes
 * suitable for wrapping in a Create activity by ap/outbox.ts or ap/deliver.ts.
 *
 * Intentionally NO @context on the output objects — the wrapping Create activity
 * carries @context. YAGNI: don't add it here unless a downstream task requires it.
 *
 * Phase C scope: text posts (Note) + longform (Article). No inReplyTo, no tag, no
 * attachment, no sensitive field.
 */

import { mdToSafeHtml, stripFrontmatter } from '../pds/longform-render'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input shape matching app.bsky.feed.post (from longform-syndication.ts BskyPost).
 * facet offsets are UTF-8 BYTE offsets into the post text — NOT JS string indices.
 */
export interface AtFacet {
  index: { byteStart: number; byteEnd: number }
  features: Array<{ $type: string; uri: string }>
}

export interface AtPost {
  text: string
  createdAt: string
  facets?: AtFacet[]
}

/**
 * Input shape matching SyndicationInput from longform-syndication.ts.
 */
export interface AtLongform {
  title: string
  content: string
  slug: string
  createdAt: string
  excerpt?: string
}

export interface PostToNoteInput {
  rkey: string
  record: AtPost
  handle: string
  origin: string
}

export interface LongformToArticleInput {
  rkey: string
  record: AtLongform
  handle: string
  /** AP origin (canonicalApOrigin) — host of the Article `id`. */
  origin: string
  /** Origin of the tenant's public pages (pageOriginFor) — host of `url`. */
  pageOrigin: string
  /**
   * The slug the RENDERER published this post under (longform index
   * `currentSlug`), NOT record.slug: the renderer normalizes it (safeSlug) and
   * may suffix a collision (`-2`). `url` must be a page that exists.
   */
  slug: string
  /** ISO time of an edit; set on Update objects so Mastodon applies the edit. */
  updated?: string
}

/** ActivityPub Note (for short-form posts). No @context — added by wrapping activity. */
export interface ApNote {
  type: 'Note'
  id: string
  url: string
  attributedTo: string
  content: string
  published: string
  updated?: string
  to: string[]
  cc: string[]
}

/** ActivityPub Article (for longform posts). No @context — added by wrapping activity.
 *
 * id:  `${apOrigin}/ap/users/${handle}/articles/${rkey}` — an AP-origin,
 *      dereferenceable, rkey-stable identity. Mastodon requires an embedded
 *      object's id host to equal the actor's host, and a non-custom sub-user's
 *      pages live on a DIFFERENT host (its handle), so the page URL cannot be
 *      the id. rkey-stable also means a slug rename never forks the identity.
 * url: the canonical PAGE `${pageOrigin}/${renderedSlug}` (martzmakes.com/<slug>).
 * name: the title. summary: HTML-escaped excerpt (plain text).
 * content: the renderer's sanitized HTML (mdToSafeHtml), capped (see
 *      ARTICLE_HTML_MAX_BYTES) — over the cap it degrades to summary + link.
 */
export interface ApArticle {
  type: 'Article'
  id: string
  url: string
  name: string
  attributedTo: string
  summary: string
  content: string
  published: string
  updated?: string
  to: string[]
  cc: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

/**
 * Deterministic excerpt char budget for longform content when no excerpt is provided.
 * Rule: strip nothing (no Markdown/HTML stripping — YAGNI, document limits below),
 * truncate to 300 characters at the last word boundary at-or-before char 300,
 * append "..." if truncation occurred.
 *
 * Limits: this rule does NOT strip Markdown syntax or HTML tags from content —
 * callers with rich content may see stray `#`, `*`, or `<tag>` in the excerpt.
 * For Phase C this is acceptable; add proper stripping if needed in a later phase.
 */
const EXCERPT_CHAR_BUDGET = 300

/**
 * Cap on the delivered Article HTML. Mastodon shows only a title + link card
 * for Articles and every follower inbox gets the whole body, so a 200 KB post
 * is pure waste (and SQS retry messages carry the body, 256 KB hard limit).
 * Over the cap the content degrades to the summary + a "read" link.
 */
export const ARTICLE_HTML_MAX_BYTES = 60_000

// ---------------------------------------------------------------------------
// HTML escaping helpers
// ---------------------------------------------------------------------------

/**
 * Escape the four mandatory HTML characters for use in text content nodes.
 * Handles < > & and " (covers attribute values too, conservatively).
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')   // must come first to avoid double-escaping
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Facet rendering (UTF-8 byte-offset aware)
// ---------------------------------------------------------------------------

/**
 * Render an AT-Proto richtext post to HTML content string.
 *
 * CRITICAL: AT-Proto facet offsets are UTF-8 BYTE offsets, not JS string indices.
 * For example, "🎉 hello" — "🎉" occupies bytes 0–3 (4 bytes) in UTF-8 but has
 * string .length === 2 in JavaScript (surrogate pair). Slicing by byte index on
 * a JS string would yield wrong results for any multi-byte character.
 *
 * Algorithm:
 *  1. Encode the entire text to a UTF-8 Buffer.
 *  2. Sort facets by byteStart ascending.
 *  3. Walk from byte cursor 0 to Buffer.length:
 *     - Emit escaped plain text for any gap before the next facet.
 *     - For each facet:
 *       - If it has a feature with $type containing "app.bsky.richtext.facet#link",
 *         render <a href="ESCAPED_URI">ESCAPED_ANCHOR_TEXT</a>.
 *       - Otherwise (mention, tag, etc.) render the underlying text as escaped
 *         plain text. Phase C: YAGNI, document here that mentions/tags are plain.
 *     - Clamp byteStart/byteEnd defensively to [cursor, bufLen] — never throw.
 *  4. Emit remaining plain text after all facets.
 *
 * Non-link facets (mentions, hashtags): rendered as escaped plain text in Phase C.
 * Overlapping facets: clamped; the second facet starts after the first ends.
 */
function renderFacets(text: string, facets: AtFacet[]): string {
  const buf = Buffer.from(text, 'utf8')
  const bufLen = buf.length

  // Sort by byteStart; stable sort on equal starts (keep order from record)
  const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart)

  let cursor = 0
  let html = ''

  for (const facet of sorted) {
    // Clamp byte range defensively
    const start = Math.max(cursor, Math.min(facet.index.byteStart, bufLen))
    const end = Math.max(start, Math.min(facet.index.byteEnd, bufLen))

    // Emit gap (plain escaped text before this facet)
    if (start > cursor) {
      html += escapeHtml(buf.slice(cursor, start).toString('utf8'))
    }

    // Decode the anchor text from the byte range
    const anchorText = buf.slice(start, end).toString('utf8')

    // Find link feature (first one wins)
    const linkFeature = facet.features.find(f => f.$type.includes('app.bsky.richtext.facet#link'))

    if (linkFeature) {
      html += `<a href="${escapeHtml(linkFeature.uri)}">${escapeHtml(anchorText)}</a>`
    } else {
      // Non-link facet: render as plain escaped text (Phase C — mentions/tags not hyperlinked)
      html += escapeHtml(anchorText)
    }

    cursor = end
  }

  // Emit remaining text after all facets
  if (cursor < bufLen) {
    html += escapeHtml(buf.slice(cursor).toString('utf8'))
  }

  return html
}

// ---------------------------------------------------------------------------
// Deterministic excerpt from longform content
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic excerpt from raw content.
 *
 * Rule: take content as-is (no Markdown/HTML stripping), truncate to
 * EXCERPT_CHAR_BUDGET (300) chars at the last word boundary at-or-before 300,
 * append "..." if truncation occurred. A "word boundary" is the last space
 * character at or before position 300; if no space exists, hard-cut at 300.
 *
 * This function is pure and deterministic: same input → same output always.
 */
function derivedExcerpt(content: string): string {
  if (content.length <= EXCERPT_CHAR_BUDGET) return content

  // Find last space at or before char 300 for a clean word boundary
  const budget = content.slice(0, EXCERPT_CHAR_BUDGET)
  const lastSpace = budget.lastIndexOf(' ')
  const cutPoint = lastSpace > 0 ? lastSpace : EXCERPT_CHAR_BUDGET
  return content.slice(0, cutPoint) + '...'
}

// ---------------------------------------------------------------------------
// Public translation functions
// ---------------------------------------------------------------------------

/**
 * Translate an app.bsky.feed.post record to an ActivityPub Note.
 *
 * content: post text with link facets rendered as <a href> HTML; all plain text
 * is HTML-escaped. Non-link facets (mentions/tags) are rendered as escaped plain
 * text (Phase C YAGNI). Facet offsets are treated as UTF-8 byte offsets per spec.
 */
export function postToNote({ rkey, record, handle, origin }: PostToNoteInput): ApNote {
  const id = `${origin}/ap/users/${handle}/posts/${rkey}`
  const attributedTo = `${origin}/ap/users/${handle}`
  const followers = `${attributedTo}/followers`

  const content =
    record.facets && record.facets.length > 0
      ? renderFacets(record.text, record.facets)
      : escapeHtml(record.text)

  return {
    type: 'Note',
    id,
    url: id,
    attributedTo,
    content,
    published: record.createdAt,
    to: [AS_PUBLIC],
    cc: [followers],
  }
}

/**
 * Translate an AT-Proto longform record to an ActivityPub Article.
 * See ApArticle for the id/url split. content is the sanitized renderer HTML
 * (no raw HTML passthrough, javascript: links dropped by mdToSafeHtml).
 */
export function longformToArticle({
  rkey,
  record,
  handle,
  origin,
  pageOrigin,
  slug,
  updated,
}: LongformToArticleInput): ApArticle {
  const url = `${pageOrigin}/${slug}`
  const attributedTo = `${origin}/ap/users/${handle}`
  const followers = `${attributedTo}/followers`

  const body = stripFrontmatter(record.content, record.title)
  const rawExcerpt = record.excerpt !== undefined ? record.excerpt : derivedExcerpt(body)
  const summary = escapeHtml(rawExcerpt)

  let content = mdToSafeHtml(body)
  if (Buffer.byteLength(content, 'utf8') > ARTICLE_HTML_MAX_BYTES) {
    content = `<p>${summary}</p><p><a href="${escapeHtml(url)}">Read the full post</a></p>`
  }

  const article: ApArticle = {
    type: 'Article',
    id: `${origin}/ap/users/${handle}/articles/${rkey}`,
    url,
    name: record.title,
    attributedTo,
    summary,
    content,
    published: record.createdAt,
    to: [AS_PUBLIC],
    cc: [followers],
  }
  if (updated) article.updated = updated
  return article
}
