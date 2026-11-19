import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { createJimp } from '@jimp/core'
import jpeg from '@jimp/js-jpeg'
import png from '@jimp/js-png'
import { methods as contain } from '@jimp/plugin-contain'
import { imageSize } from 'image-size'
import { absoluteImageUrl, type CoverPreview } from './longform-preview'

const Image = createJimp({ formats: [jpeg, png], plugins: [contain] })
const width = 1200
const height = 630
const mimeType = 'image/jpeg'
const maxInputBytes = 8_000_000
const maxInputPixels = 12_000_000
const blobPath = '/xrpc/com.atproto.sync.getBlob'
const rawCid = /^bafkrei[a-z2-7]{52}$/

/** Scoped to platform-owned, already-public PDS blobs. External image URLs are emitted as metadata only. */
export function coverBlobCid(cover: unknown, siteOrigin: string, pdsOrigin: string, did: string) {
  const href = absoluteImageUrl(cover, siteOrigin)
  if (!href) return
  const url = new URL(href)
  if ((url.origin !== pdsOrigin && url.origin !== siteOrigin) || url.pathname !== blobPath ||
      url.searchParams.get('did') !== did) return
  const cid = url.searchParams.get('cid')
  return cid && rawCid.test(cid) ? cid : undefined
}

export async function makeCoverJpeg(source: Buffer): Promise<Buffer | undefined> {
  if (source.length > maxInputBytes) return
  const size = imageSize(source)
  if ((size.type !== 'png' && size.type !== 'jpg') || size.width * size.height > maxInputPixels) return
  const image = await Image.fromBuffer(source)
  image.background = 0x101521ff
  image.contain({ w: width, h: height })
  return image.getBuffer(mimeType, { quality: 82 })
}

async function fetchCover(pdsOrigin: string, did: string, cid: string): Promise<Buffer | undefined> {
  const url = new URL(blobPath, pdsOrigin)
  url.search = new URLSearchParams({ did, cid }).toString()
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  if (!response.ok || !response.body) return
  const reader = response.body.getReader()
  if (Number(response.headers.get('content-length')) > maxInputBytes) {
    await reader.cancel()
    return
  }
  const parts: Uint8Array[] = []
  let length = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    length += result.value.byteLength
    if (length > maxInputBytes) {
      await reader.cancel()
      return
    }
    parts.push(result.value)
  }
  return Buffer.concat(parts, length)
}

export async function prepareCoverPreview(options: {
  s3: S3Client
  bucket: string
  siteOrigin: string
  pdsOrigin: string
  did: string
  cover: unknown
}): Promise<CoverPreview | undefined> {
  const { s3, bucket, siteOrigin, pdsOrigin, did, cover } = options
  const cid = coverBlobCid(cover, siteOrigin, pdsOrigin, did)
  if (!cid) return
  const key = `assets/og/v1/${cid}.jpg`
  const preview = { url: `${siteOrigin}/${key}`, width, height, mimeType }
  const object = { Bucket: bucket, Key: key }
  try {
    await s3.send(new HeadObjectCommand(object))
    return preview
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode !== 404) throw error
  }
  const source = await fetchCover(pdsOrigin, did, cid)
  if (!source) return
  const body = await makeCoverJpeg(source)
  if (!body) return
  try {
    await s3.send(new PutObjectCommand({
      ...object, Body: body, ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable', IfNoneMatch: '*',
    }))
  } catch (error) {
    // Another writer may have published the same content-addressed preview.
    if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode !== 412) throw error
  }
  return preview
}
