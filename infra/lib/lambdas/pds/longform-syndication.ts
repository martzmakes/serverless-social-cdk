import type { RenderCtx } from './longform-render'

export interface SyndicationInput {
  title: string; content: string; slug: string; createdAt: string
  excerpt?: string; syndicationTeaser?: string
}
export interface BskyPost {
  $type: 'app.bsky.feed.post'
  text: string
  createdAt: string
  facets?: Array<{ index: { byteStart: number; byteEnd: number }, features: Array<{ $type: string; uri: string }> }>
  embed?: { $type: 'app.bsky.embed.external'; external: { uri: string; title: string; description: string } }
}
export interface SyndicationTarget {
  readonly id: string
  build(rec: SyndicationInput, ctx: RenderCtx): BskyPost
}

const stripMd = (s: string) =>
  s.replace(/[#*`>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim()

export function pickTeaser(rec: SyndicationInput): string {
  const raw = (rec.syndicationTeaser && rec.syndicationTeaser.trim())
    || (rec.excerpt && rec.excerpt.trim())
    || stripMd(rec.content)
  return [...raw].slice(0, 300).join('')
}

export function buildBlueskySyndication(rec: SyndicationInput, ctx: RenderCtx): BskyPost {
  const url = `${ctx.origin}/${rec.slug}`
  const teaser = pickTeaser({ ...rec, syndicationTeaser: rec.syndicationTeaser })
  const text = `${teaser}\n\n${url}`
  const enc = (s: string) => Buffer.byteLength(s, 'utf8')
  const byteStart = enc(text.slice(0, text.length - url.length))
  return {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: rec.createdAt,
    facets: [{
      index: { byteStart, byteEnd: byteStart + enc(url) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    }],
    embed: {
      $type: 'app.bsky.embed.external',
      external: { uri: url, title: rec.title, description: rec.excerpt || teaser },
    },
  }
}

export const blueskyTarget: SyndicationTarget = {
  id: 'bsky',
  build: buildBlueskySyndication,
}
