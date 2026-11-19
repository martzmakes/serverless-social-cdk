import { describe, expect, it } from 'vitest'
import { imageSize } from 'image-size'
import { coverBlobCid, makeCoverJpeg } from '../lib/lambdas/pds/cover-preview'
import { patchArticleShareMetadata } from '../lib/lambdas/pds/longform-preview'
import { renderArticleHtml } from '../lib/lambdas/pds/longform-render'

const origin = 'https://writer.example.com'
const did = 'did:plc:writer'
const cid = 'bafkreie5d6fmn3mrheqctxn7atuo2asbj5mhuuycuygft3udjwjqfrwkoa'
const blob = `/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}`
const preview = { url: `${origin}/assets/og/v1/${cid}.jpg`, width: 1200, height: 630, mimeType: 'image/jpeg' }
const article = {
  title: 'Launch notes', slug: 'launch-notes', createdAt: '2026-10-01T12:00:00Z',
  content: `![A launch photo](${blob})\n\nThe public article.`, coverImage: blob,
}
const site = { origin, siteName: 'Writer', author: 'writer.example.com' }

describe('article share images', () => {
  it('selects only the post owner’s platform blob for optimization', () => {
    expect(coverBlobCid(blob, origin, 'https://social.example.com', did)).toBe(cid)
    expect(coverBlobCid(`https://other.example.com${blob}`, origin, 'https://social.example.com', did)).toBeUndefined()
    expect(coverBlobCid(blob, origin, 'https://social.example.com', 'did:plc:other')).toBeUndefined()
  })

  it('creates a JPEG with actual social card dimensions', async () => {
    const source = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4P/MMHDEgcwD6UhMh3yhRGgAAAABJRU5ErkJggg==', 'base64')
    const jpg = await makeCoverJpeg(source)
    expect(jpg).toBeDefined()
    expect(imageSize(jpg!)).toMatchObject({ type: 'jpg', width: 1200, height: 630 })
  })

  it('advertises the thumbnail and cover description while keeping the original article image', () => {
    const html = renderArticleHtml(article, { ...site, coverPreview: preview })
    expect(html).toContain(`<meta property="og:image" content="${preview.url}">`)
    expect(html).toContain(`<meta name="twitter:image" content="${preview.url}">`)
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">')
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta property="og:image:alt" content="A launch photo">')
    expect(html).toContain('<meta name="twitter:image:alt" content="A launch photo">')
    expect(html).toContain(`<img src="${blob.replace('&', '&amp;')}" alt="A launch photo"`)
  })

  it('refreshes cached article tags without rewriting its body or stale content', () => {
    const original = renderArticleHtml(article, site)
    const tags = { url: preview.url, preview, alt: 'A launch photo', isCover: true }
    const migrated = patchArticleShareMetadata(original, origin + blob, tags)
    expect(migrated.split('</head>')[1]).toEqual(original.split('</head>')[1])
    expect(migrated).toContain('og:image:height" content="630')
    expect(patchArticleShareMetadata(migrated, origin + blob, tags)).toEqual(migrated)
    expect(patchArticleShareMetadata(original, origin + '/different.jpg', tags)).toEqual(original)
  })

  it('uses an absolute original when no thumbnail is available and the default for unsafe URLs', () => {
    const html = renderArticleHtml({ ...article, coverImageAlt: 'A "paper" sketch' }, site)
    expect(html).toContain(`<meta property="og:image" content="${origin}${blob.replace('&', '&amp;')}">`)
    expect(html).toContain('content="A &quot;paper&quot; sketch"')
    expect(html).not.toContain('og:image:width')
    const fallback = renderArticleHtml({ ...article, coverImage: 'javascript:alert(1)' }, site)
    expect(fallback).toContain(`<meta property="og:image" content="${origin}/og-default.png">`)
    expect(fallback).not.toContain('og:image:alt')
  })
})
