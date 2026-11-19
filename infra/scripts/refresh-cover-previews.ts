import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { prepareCoverPreview } from '../lib/lambdas/pds/cover-preview'
import { coverAltText } from '../lib/lambdas/pds/longform-render'
import { absoluteImageUrl, patchArticleShareMetadata } from '../lib/lambdas/pds/longform-preview'

const { values: options } = parseArgs({ options: {
  'site-origin': { type: 'string' },
  'pds-origin': { type: 'string' },
  did: { type: 'string' },
  bucket: { type: 'string' },
  'index-table': { type: 'string' },
  prefix: { type: 'string', default: '' },
  slug: { type: 'string' },
  'backup-dir': { type: 'string' },
  apply: { type: 'boolean', default: false },
} })

type PublishedRow = { rkey: string; currentSlug: string; status: string }
type PublishedRecord = { uri: string; value: { coverImage?: unknown; coverImageAlt?: unknown; content?: string } }

async function main() {
  const { did, bucket, prefix, slug, apply } = options
  const siteOrigin = options['site-origin']
  const pdsOrigin = options['pds-origin']
  const table = options['index-table']
  const backup = options['backup-dir']
  if (!did || !bucket || !siteOrigin || !pdsOrigin || !table ||
      ![siteOrigin, pdsOrigin].every(value => new URL(value).origin === value && value.startsWith('https://')) ||
      !/^(?:t\/[a-z0-9.-]+\/)?$/.test(prefix) || (apply && !backup)) {
    throw new Error('Provide --site-origin, --pds-origin, --did, --bucket, --index-table, optional --prefix/--slug, and --backup-dir with --apply.')
  }

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const s3 = new S3Client({})
  const records = new Map<string, PublishedRecord['value']>()
  let cursor: string | undefined
  do {
    const url = new URL('/xrpc/com.atproto.repo.listRecords', pdsOrigin)
    url.search = new URLSearchParams({ repo: did, collection: 'social.serverless.longform', limit: '100', ...(cursor ? { cursor } : {}) }).toString()
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`listRecords returned ${res.status}`)
    const data = await res.json() as { records: PublishedRecord[]; cursor?: string }
    for (const record of data.records) {
      if (record.value.coverImage) records.set(record.uri.split('/').at(-1)!, record.value)
    }
    cursor = data.cursor
  } while (cursor)

  const rows: PublishedRow[] = []
  let pageKey: Record<string, unknown> | undefined
  do {
    const result = await db.send(new QueryCommand({
      TableName: table, KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': prefix ? `IDX#${did}` : 'IDX' },
      ExclusiveStartKey: pageKey,
    }))
    rows.push(...(result.Items ?? []).map(row => row.item))
    pageKey = result.LastEvaluatedKey
  } while (pageKey)

  const candidates = rows.filter(row => row.status === 'published' && (!slug || row.currentSlug === slug) && records.has(row.rkey))
  const updated: string[] = []
  if (apply) await mkdir(backup!, { recursive: true, mode: 0o700 })
  for (const row of candidates) {
    if (!/^[a-z0-9-]{1,600}$/.test(row.currentSlug)) throw new Error('Unexpected published slug')
    const record = records.get(row.rkey)!
    const url = absoluteImageUrl(record.coverImage, siteOrigin)
    if (!url) continue
    if (!apply) {
      console.log(`Would review ${row.currentSlug}`)
      continue
    }
    const key = `${prefix}${row.currentSlug}/index.html`
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!object.Body || !object.ETag) throw new Error(`Missing article at ${key}`)
    const html = await object.Body.transformToString()
    const preview = await prepareCoverPreview({ s3, bucket, siteOrigin, pdsOrigin, did, cover: record.coverImage })
      .catch(error => {
        console.warn(`Thumbnail unavailable for ${row.currentSlug} (${(error as Error).name})`)
        return undefined
      })
    const next = patchArticleShareMetadata(html, url, {
      url: preview?.url ?? url, preview, alt: coverAltText(record.coverImageAlt, record.content ?? '', url, siteOrigin), isCover: true,
    })
    if (next === html) continue
    const destination = path.join(backup!, row.currentSlug)
    await mkdir(destination, { mode: 0o700 })
    await writeFile(path.join(destination, 'index.html'), html, { flag: 'wx', mode: 0o600 })
    await writeFile(path.join(destination, 'metadata.json'), JSON.stringify({
      key, etag: object.ETag, contentType: object.ContentType, cacheControl: object.CacheControl,
    }), { flag: 'wx', mode: 0o600 })
    const written = await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: next, IfMatch: object.ETag,
      ContentType: object.ContentType ?? 'text/html; charset=utf-8',
      CacheControl: object.CacheControl, ContentLanguage: object.ContentLanguage,
      ContentEncoding: object.ContentEncoding, Metadata: object.Metadata,
    }))
    await writeFile(path.join(destination, 'applied-etag'), String(written.ETag), { flag: 'wx', mode: 0o600 })
    updated.push(row.currentSlug)
    console.log(`Refreshed ${row.currentSlug}${preview ? ' with a JPEG thumbnail' : ''}`)
  }
  if (apply) await writeFile(path.join(backup!, 'updated.json'), JSON.stringify(updated), { flag: 'wx', mode: 0o600 })
  console.log(`${candidates.length} published covers found, ${updated.length} pages updated.`)
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
