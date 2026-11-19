/**
 * ap/sanitize.ts - remote ActivityPub content is UNTRUSTED.
 *
 * sanitizeHtml parses with parse5 (the HTML5 spec parser, same one jsdom uses,
 * so there is no regex HTML parsing) and then serializes ONLY an allowlist
 * from the parsed tree, itself. Nothing from the input is ever echoed except
 * escaped text nodes and one validated href:
 *
 *   tags      p br a span strong em code pre blockquote ul ol li
 *   attrs     none, except a[href] (https only, no credentials) which always
 *             gets rel="nofollow noopener"
 *   dropped   script style iframe object embed svg math template textarea ...
 *             WITH their content; comments / doctype / PIs entirely
 *   unwrapped every other element (div, h1, img, form...): children kept,
 *             tag dropped
 *
 * Output is built from escaped pieces, so a mutation-XSS style re-parse in the
 * client can only ever see the allowlist.
 *
 * Plain-text helpers (names, alt text) are NOT HTML: they are stripped of
 * control/bidi characters and length-capped, and must be rendered as text.
 */
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

/** Elements whose CONTENT is dropped too (never unwrapped). */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'noscript', 'template', 'svg', 'math', 'textarea', 'title', 'xmp', 'noembed',
  'noframes', 'plaintext', 'head', 'select',
])

export const MAX_HREF_LENGTH = 2048
export const MAX_HTML_INPUT_CHARS = 50_000
const MAX_DEPTH = 40

const escText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) =>
  escText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** https URL without credentials, re-serialized by the URL parser. */
export function safeHttpsUrl(v: unknown, maxLen = MAX_HREF_LENGTH): string | undefined {
  if (typeof v !== 'string' || v.length > maxLen * 2) return undefined
  let u: URL
  try {
    u = new URL(v.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' || !u.hostname) return undefined
  if (u.username || u.password) return undefined
  const href = u.href
  return href.length <= maxLen ? href : undefined
}

export const attr = (el: Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value

/** Mastodon marks the scheme / tail of a long URL `invisible`: drop those. */
function isInvisibleSpan(el: Element): boolean {
  if (el.tagName !== 'span') return false
  return (attr(el, 'class') ?? '').split(/\s+/).includes('invisible')
}

type Work = { node: Node; depth: number } | { raw: string }

/**
 * Per-profile allowlist. `sanitizeHtml` (remote AP content) uses the strict
 * profile; the post renderer (pds/longform-render.ts) passes a richer one for
 * headings, tables, code, img and hr. Same parse5 walk, same escaping.
 */
export interface SanitizeProfile {
  allowed: ReadonlySet<string>
  /** Elements emitted as `<tag>` with no children or closing tag. */
  voidTags: ReadonlySet<string>
  /** Returns the validated, UNESCAPED attributes to emit for an element (null = drop element, unwrap). */
  attrs(el: Element, tag: string): [string, string][] | null
  maxChars: number
  /** Keep whitespace-only text between these container tags' children out of the output. */
  compactTags?: ReadonlySet<string>
  /** Collapse newlines in text to a space except inside these tags. */
  collapseNewlinesExcept?: ReadonlySet<string>
}

export function sanitizeWithProfile(input: unknown, profile: SanitizeProfile): string {
  if (typeof input !== 'string' || !input) return ''
  const html = input.length > profile.maxChars ? input.slice(0, profile.maxChars) : input
  const root = parseFragment(html)
  let out = ''
  // Iterative walk (explicit stack): hostile deep nesting cannot overflow.
  const stack: Work[] = []
  const pushChildren = (children: Node[], depth: number) => {
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth })
  }
  pushChildren(root.childNodes as Node[], 0)
  // Open-element names, for text-context decisions (pre / compact containers).
  const open: string[] = []
  while (stack.length) {
    const w = stack.pop()!
    if ('raw' in w) {
      if (w.raw.startsWith('</')) open.pop()
      out += w.raw
      continue
    }
    const node = w.node
    if (node.nodeName === '#text') {
      let t = (node as any).value as string
      const parent = open[open.length - 1]
      if (!t.trim()) {
        if (profile.compactTags?.has(parent)) continue
        if (parent === undefined && profile.compactTags) {
          out += '\n' // top-level block separator (profiles with compactTags only)
          continue
        }
      }
      if (profile.collapseNewlinesExcept && !open.some((o) => profile.collapseNewlinesExcept!.has(o))) {
        t = t.replace(/\s*\n\s*/g, ' ')
      }
      out += escText(t)
      continue
    }
    if (!('tagName' in node)) continue // comment, doctype, PI: dropped
    const el = node as Element
    const tag = el.tagName
    if (DROP_WITH_CONTENT.has(tag) || isInvisibleSpan(el)) continue
    const children = ((el as any).content?.childNodes ?? el.childNodes) as Node[]
    const depth = w.depth + 1
    if (!profile.allowed.has(tag) || depth > MAX_DEPTH) {
      pushChildren(children, depth) // unwrap
      continue
    }
    const attrs = profile.attrs(el, tag)
    if (!attrs) {
      pushChildren(children, depth)
      continue
    }
    const attrStr = attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')
    if (profile.voidTags.has(tag)) {
      out += `<${tag}${attrStr}>`
      continue
    }
    out += `<${tag}${attrStr}>`
    open.push(tag)
    stack.push({ raw: `</${tag}>` })
    pushChildren(children, depth)
  }
  return out
}

const STRICT: SanitizeProfile = {
  allowed: new Set(['p', 'br', 'a', 'span', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li']),
  voidTags: new Set(['br']),
  maxChars: MAX_HTML_INPUT_CHARS,
  attrs(el, tag) {
    if (tag !== 'a') return []
    const href = safeHttpsUrl(attr(el, 'href'))
    return href ? [['href', href], ['rel', 'nofollow noopener']] : null
  },
}

export function sanitizeHtml(input: unknown): string {
  return sanitizeWithProfile(input, STRICT)
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/** Plain text (NOT html): strip control + bidi characters, cap length. */
export function sanitizePlainText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  return v.replace(CONTROL, '').slice(0, max)
}

export const MAX_ATTACHMENTS = 4
export const MAX_ALT_LENGTH = 1500
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|avif|heic)$/i

/** Image https urls + plain-text alt only. Never proxied. */
export function sanitizeAttachments(v: unknown): { url: string; alt: string }[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []
  const out: { url: string; alt: string }[] = []
  for (const a of list) {
    if (out.length >= MAX_ATTACHMENTS) break
    if (!a || typeof a !== 'object') continue
    const mt = (a as any).mediaType
    if (typeof mt === 'string') {
      if (!IMAGE_TYPES.test(mt)) continue
    } else if ((a as any).type !== 'Image') {
      continue
    }
    const raw = (a as any).url
    const url = safeHttpsUrl(typeof raw === 'string' ? raw : raw?.href)
    if (!url) continue
    out.push({ url, alt: sanitizePlainText((a as any).name, MAX_ALT_LENGTH) ?? '' })
  }
  return out
}
