import type { RenderCtx } from './longform-render'
export interface FeedItem { slug: string; title: string; excerpt?: string; createdAt: string }

const xe = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const byNewest = (a: FeedItem, b: FeedItem) => b.createdAt.localeCompare(a.createdAt)

export function renderSitemap(items: FeedItem[], ctx: RenderCtx): string {
  const urls = [...items].sort(byNewest).map(i =>
    `<url><loc>${ctx.origin}/${i.slug}</loc><lastmod>${i.createdAt}</lastmod></url>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ctx.origin}/</loc></url>${urls}</urlset>`
}

export function renderRss(items: FeedItem[], ctx: RenderCtx): string {
  const its = [...items].sort(byNewest).map(i =>
    `<item><title>${xe(i.title)}</title><link>${ctx.origin}/${i.slug}</link>` +
    `<guid isPermaLink="true">${ctx.origin}/${i.slug}</guid>` +
    `<pubDate>${new Date(i.createdAt).toUTCString()}</pubDate>` +
    `<description>${xe(i.excerpt || '')}</description></item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${xe(ctx.siteName)}</title>` +
    `<link>${ctx.origin}/</link><description>${xe(ctx.siteName)} — long-form</description>${its}</channel></rss>`
}

export function renderAtom(items: FeedItem[], ctx: RenderCtx): string {
  const updated = items.length ? [...items].sort(byNewest)[0].createdAt : new Date(0).toISOString()
  const its = [...items].sort(byNewest).map(i =>
    `<entry><title>${xe(i.title)}</title><link href="${ctx.origin}/${i.slug}"/>` +
    `<id>${ctx.origin}/${i.slug}</id><updated>${i.createdAt}</updated>` +
    `<summary>${xe(i.excerpt || '')}</summary></entry>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">` +
    `<title>${xe(ctx.siteName)}</title><id>${ctx.origin}/</id><updated>${updated}</updated>${its}</feed>`
}
