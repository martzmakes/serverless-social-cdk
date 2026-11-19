/**
 * blobs.ts — AT Protocol blob subsystem (S3-backed).
 *
 * Blob CID algorithm (per AT Protocol spec):
 *   CIDv1, codec raw (0x55), multihash sha-256
 *   String form is base32 lower "bafkrei…"
 *
 * Uses @atproto/lex-data's `cidForRawBytes` which is the canonical implementation
 * of this algorithm in the AT Protocol reference stack:
 *   sha256.digest(bytes) → CID.createV1(RAW_DATA_CODEC=0x55, multihash)
 *
 * JSON wire format for uploadBlob response:
 *   { blob: { $type: 'blob', ref: { $link: '<cidStr>' }, mimeType, size } }
 *
 * S3 key layout: blobs/<cidStr>
 *
 * Reference: ~/dev/atproto/packages/lex/lex-data/src/cid.ts (cidForRawBytes)
 *            ~/dev/atproto/packages/lex/lex-json/src/link.ts (encodeLexLink → { $link })
 */

import { cidForRawBytes, type RawCid } from '@atproto/lex-data'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// CID helpers
// ---------------------------------------------------------------------------

/**
 * Compute CIDv1 raw sha-256 for the given bytes.
 * Delegates to @atproto/lex-data's `cidForRawBytes` which is the canonical
 * implementation: CID.createV1(0x55, await sha256.digest(bytes)).
 */
export async function blobCid(bytes: Uint8Array): Promise<RawCid> {
  return cidForRawBytes(bytes)
}

/**
 * Build the JSON-wire blob ref object that `uploadBlob` returns.
 *
 * Wire format (per AT Protocol lexicon + @atproto/lex-json encodeLexLink):
 *   { $type: 'blob', ref: { $link: '<cidStr>' }, mimeType, size }
 *
 * The `ref: { $link: cidStr }` is the AT Protocol JSON encoding of a CID link.
 */
export function cidToBlobRef(
  cid: RawCid,
  mimeType: string,
  size: number,
): { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number } {
  return {
    $type: 'blob',
    ref: { $link: cid.toString() },
    mimeType,
    size,
  }
}

// ---------------------------------------------------------------------------
// S3 operations
// ---------------------------------------------------------------------------

export type BlobPutResult = {
  blob: { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }
  cidStr: string
}

/**
 * Store raw bytes in S3 under key `blobs/<cidStr>`.
 * Returns the blob ref object ready to embed in the XRPC response.
 */
export async function putBlob(
  s3: S3Client,
  bucket: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<BlobPutResult> {
  const cid = await blobCid(bytes)
  const cidStr = cid.toString()
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `blobs/${cidStr}`,
      Body: bytes,
      ContentType: mimeType,
      Metadata: { 'atproto-cid': cidStr },
    }),
  )
  const blob = cidToBlobRef(cid, mimeType, bytes.length)
  return { blob, cidStr }
}

/**
 * Retrieve a blob from S3 by its CID string.
 * Returns null if the object does not exist (NoSuchKey).
 */
export async function getBlob(
  s3: S3Client,
  bucket: string,
  cidStr: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `blobs/${cidStr}`,
      }),
    )
    if (!res.Body) return null
    // The SDK Body is a readable stream with .transformToByteArray() in Node.js
    const bytes = await (res.Body as any).transformToByteArray()
    const mimeType = res.ContentType ?? 'application/octet-stream'
    return { bytes, mimeType }
  } catch (err: any) {
    // S3 throws NoSuchKey when the object is missing
    if (err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey') return null
    throw err
  }
}
