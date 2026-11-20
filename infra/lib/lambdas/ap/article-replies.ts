import { createHash } from 'node:crypto'
import { articleRepliesPartition, noteKey, type InboundRecord } from './ingest'
import { escapeHtml, type ApNote } from './translate'

export const replyRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const articleRecordKey = /^(?!\.{1,2}$)[a-zA-Z0-9._~:-]{1,512}$/
export const outgoingRepliesPartition = (handle: string) => `ap-outgoing-replies#${handle}`
export const blueskyOnlyPartition = (did: string) => `bluesky-only#${did}`
export const incomingArticleReplyKey = (handle: string, id: string) => ({ pk: articleRepliesPartition(handle), sk: noteKey(id) })

export const replyContentDigest = (network: string, rkey: string, parent: string, text: string) =>
  createHash('sha256').update(JSON.stringify([network, rkey, parent, text])).digest('hex')

export function validReplyText(text: unknown): text is string {
  return typeof text === 'string' && !!text.trim() && Buffer.byteLength(text) <= 3000 &&
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length <= 300
}

export function isCurrentArticleReply(row: InboundRecord | undefined, rkey: string, id: string, now = Date.now()): row is InboundRecord {
  return !!row && row.sortKey.startsWith(`${rkey}#`) && row.item.id === id &&
    row.owner === row.item.actor.id && row.ttl > Math.floor(now / 1000)
}

export interface OutgoingArticleReply {
  requestId: string
  articleRkey: string
  fingerprint: string
  inbox: string
  note: ApNote & {
    inReplyTo: string
    tag: { type: 'Mention'; href: string; name: string }[]
  }
}

export interface ArticleReplyStore {
  incoming(handle: string, id: string): Promise<InboundRecord | undefined>
  outgoing(handle: string, requestId: string): Promise<OutgoingArticleReply | undefined>
  putOutgoing(handle: string, reply: OutgoingArticleReply): Promise<boolean>
}

export function makeArticleReply(
  actor: string, requestId: string, articleRkey: string, parent: Pick<InboundRecord, 'owner' | 'item'>, inbox: string, text: string,
): OutgoingArticleReply {
  const id = `${actor}/replies/${requestId}`
  const recipient = new URL(parent.owner)
  const cached = parent.item.actor.handle.replace(/^@/, '')
  const username = cached.includes('@') ? cached.split('@')[0] : recipient.pathname.split('/').filter(Boolean).at(-1)
  const name = username ? `@${username}@${recipient.hostname}` : recipient.hostname
  return {
    requestId, articleRkey, inbox, fingerprint: replyContentDigest('Fediverse', articleRkey, parent.item.id, text),
    note: {
      id, url: id, type: 'Note', attributedTo: actor, inReplyTo: parent.item.id,
      content: `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`,
      published: new Date().toISOString(),
      to: [parent.owner], cc: ['https://www.w3.org/ns/activitystreams#Public'],
      tag: [{ type: 'Mention', href: parent.owner, name }],
    },
  }
}
