export interface CoverPreview {
  url: string
  width: number
  height: number
  mimeType: string
}

export type ArticleShareImage = CoverPreview & { alt: string }

export function absoluteImageUrl(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return
  try {
    const url = new URL(value, `${origin}/`)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return url.href
    }
  } catch { /* Invalid image URL. */ }
  return undefined
}

const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function shareImageTags(image: { url: string; preview?: CoverPreview; alt?: string; isCover?: boolean }) {
  const url = attr(image.url)
  const openGraph = [`<meta property="og:image" content="${url}">`]
  const twitter = [`<meta name="twitter:image" content="${url}">`]
  if ((image.isCover || image.preview) && image.url.startsWith('https:')) {
    openGraph.push(`<meta property="og:image:secure_url" content="${url}">`)
  }
  if (image.preview) {
    openGraph.push(
      `<meta property="og:image:type" content="${attr(image.preview.mimeType)}">`,
      `<meta property="og:image:width" content="${image.preview.width}">`,
      `<meta property="og:image:height" content="${image.preview.height}">`,
    )
  }
  const alt = typeof image.alt === 'string' ? image.alt.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  if (alt) {
    openGraph.push(`<meta property="og:image:alt" content="${attr(alt)}">`)
    twitter.push(`<meta name="twitter:image:alt" content="${attr(alt)}">`)
  }
  return { openGraph: openGraph.join('\n'), twitter: twitter.join('\n') }
}

/** Refresh share metadata in an existing generated page while preserving its body and canonical URL. */
export function patchArticleShareMetadata(html: string, previousUrl: string, image: Parameters<typeof shareImageTags>[0]): string {
  const end = html.indexOf('</head>')
  if (end < 0) return html
  const head = html.slice(0, end)
  const openGraph = /^<meta property="og:image" content="([^"\n]*)">(?:\n<meta property="og:image:[a-z_]+" content="[^"\n]*">)*/m
  const twitter = /^<meta name="twitter:image" content="[^"\n]*">(?:\n<meta name="twitter:image:alt" content="[^"\n]*">)?/m
  const current = openGraph.exec(head)?.[1]
  if ((current !== attr(previousUrl) && current !== attr(image.url)) || !twitter.test(head)) return html
  const next = shareImageTags(image)
  return head.replace(openGraph, () => next.openGraph).replace(twitter, () => next.twitter) + html.slice(end)
}
