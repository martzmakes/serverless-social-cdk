import type { IndexItem } from './longform-index'
import type { RenderCtx } from './longform-render'

const htmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Minimal brand CSS — kept in sync with longform-render.ts BRAND_CSS.
 *  Index page adds .post-list / .post-item classes; core palette/fonts identical. */
const INDEX_CSS = `
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
.site-header .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}
.brand{color:#EEF1F6;font-weight:600;font-size:16px;letter-spacing:-0.01em}
.brand:hover{color:#EEF1F6}
.eyebrow{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#8892A0}
main{padding:56px 0 40px}
h1.page-title{color:#EEF1F6;font-weight:600;font-size:clamp(26px,4vw,36px);
  line-height:1.15;letter-spacing:-0.02em;margin:0 0 40px}
.post-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:32px}
.post-item{border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:32px}
.post-item:last-child{border-bottom:0}
.post-title{color:#EEF1F6;font-weight:600;font-size:20px;line-height:1.3;
  letter-spacing:-0.01em;margin:0 0 6px}
.post-title a{color:#EEF1F6;text-decoration:none}
.post-title a:hover{color:#5897FF}
.post-excerpt{color:#B8C0CC;margin:0 0 8px;font-size:16px}
.post-date{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;color:#8892A0}
.site-footer{border-top:1px solid rgba(255,255,255,0.06);margin-top:56px;padding:28px 0 56px}
.site-footer .wrap{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:center;
  font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;color:#8892A0}
.site-footer a{color:#8892A0}
.site-footer a:hover{color:#EEF1F6}
@media(max-width:640px){main{padding:32px 0}}
`.replace(/\n\s*/g, '')

/**
 * Render a pure, self-contained index/home page for a non-apex tenant.
 *
 * - Filters: only `status === 'published'` items are shown.
 * - Order: reverse-chronological by `publishedAt`; falls back to `createdAt`
 *   when `publishedAt` is empty/missing.
 * - Links: `${ctx.origin}/${item.currentSlug}` — no unsafe interpolation.
 * - Escaping: all user-controlled strings (title, excerpt, siteName, author)
 *   are passed through `htmlEscape` before embedding in HTML.
 */
export function renderIndexPage(items: IndexItem[], ctx: RenderCtx): string {
  const safeOrigin = htmlEscape(ctx.origin)
  const safeSiteName = htmlEscape(ctx.siteName)

  const published = items.filter(i => i.status === 'published')
  // Sort newest-first: prefer publishedAt, fall back to createdAt
  published.sort((a, b) => {
    const aDate = a.publishedAt || a.createdAt
    const bDate = b.publishedAt || b.createdAt
    return bDate.localeCompare(aDate)
  })

  const postsHtml = published.length === 0
    ? ''
    : `<ul class="post-list">\n${published.map(item => {
        const href = `${safeOrigin}/${htmlEscape(item.currentSlug)}`
        const title = htmlEscape(item.title)
        const excerpt = item.excerpt ? `<p class="post-excerpt">${htmlEscape(item.excerpt)}</p>` : ''
        const dateStr = (item.publishedAt || item.createdAt).slice(0, 10)
        const safeDate = htmlEscape(dateStr)
        return `<li class="post-item">
<h2 class="post-title"><a href="${href}">${title}</a></h2>
${excerpt}<time class="post-date" datetime="${safeDate}">${safeDate}</time>
</li>`
      }).join('\n')}\n</ul>`

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07090C">
<title>${safeSiteName}</title>
<meta name="description" content="Posts by ${safeSiteName}">
<link rel="canonical" href="${safeOrigin}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${safeSiteName}">
<meta property="og:title" content="${safeSiteName}">
<meta property="og:url" content="${safeOrigin}/">
<link rel="alternate" type="application/rss+xml" href="${safeOrigin}/rss.xml">
<link rel="icon" href="${safeOrigin}/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&amp;display=swap">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&amp;display=swap">
<style>${INDEX_CSS}</style>
</head><body>
<header class="site-header"><div class="wrap">
<a class="brand" href="${safeOrigin}">${safeSiteName}</a>
<span class="eyebrow">Long-form</span>
</div></header>
<main><div class="wrap">
<h1 class="page-title">${safeSiteName}</h1>
${postsHtml}
</div></main>
<footer class="site-footer"><div class="wrap">
<a href="${safeOrigin}">${safeSiteName}</a>
<a href="${safeOrigin}/rss.xml">RSS</a>
</div></footer>
</body></html>`
}
