/**
 * ap/outbox.ts — pure ActivityPub OrderedCollection / OrderedCollectionPage builders
 *
 * No I/O. No side effects. Produces AP outbox shapes for consumption by the
 * outbox handler (Task 6), the deliver module (Task 7), and live-proof (Task 10).
 *
 * Design decisions (documented here; Task 6/handler owns real cursor wiring):
 *
 * Collection id: `${actorId}/outbox`
 *   actorId is the full actor URL, e.g. https://serverless.social/ap/users/serverless.social
 *
 * Page id: `selfUrl ?? ${actorId}/outbox?page=true`
 *   The caller (handler, Task 6) MUST pass the actual request URL as `selfUrl`
 *   so each cursor page self-identifies correctly (required for Mastodon AP
 *   traversal/dedup). The `?page=true` default is only a backward-compat
 *   fallback for callers that do not supply selfUrl.
 *   The builder stays pure and cursor-agnostic — it does NOT invent a cursor
 *   scheme; the caller supplies selfUrl.
 *
 * Page `next` (only when nextCursor given): `${actorId}/outbox?page=${encodeURIComponent(nextCursor)}`
 *   URL-encoding the cursor makes it safe for any opaque cursor value.
 *
 * Create activity id: `${item.id}/activity`
 *   Stable and deterministic — one Create per content object, identity derived
 *   from the object's own id. Follows Mastodon / standard AP convention.
 *
 * Fields on Create: id, type, actor, object, to, cc, published — YAGNI.
 *   `actor` (not `attributedTo`) is the correct field for the activity author.
 *   No `summary`, no `attributedTo`, no `context`.
 *
 * Page fields: @context, type, id, partOf, orderedItems, next? — YAGNI.
 *   No `summary`, no `last`, no `prev`, no `totalItems` on the page
 *   (totalItems lives on the collection, not the page — AP spec §5.1).
 */

import type { ApNote, ApArticle } from './translate'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Union of content objects that can appear in the outbox. */
export type ApOutboxItem = ApNote | ApArticle

/**
 * AP Create activity wrapping an outbox content object.
 * id = `${object.id}/activity` — deterministic, stable, one per content item.
 */
export interface Create {
  id: string
  type: 'Create'
  actor: string
  object: ApOutboxItem
  to: string[]
  cc: string[]
  published: string
}

/** AP Update activity (an edit). `id` must differ per edit (callers pass one). */
export interface Update {
  id: string
  type: 'Update'
  actor: string
  object: ApOutboxItem
  to: string[]
  cc: string[]
  published: string
}

/** AP Delete activity whose object is a Tombstone for the removed item. */
export interface Delete {
  id: string
  type: 'Delete'
  actor: string
  object: { id: string; type: 'Tombstone' }
  to: string[]
  cc: string[]
}

/**
 * AP OrderedCollection — top-level outbox descriptor.
 * id = `${actorId}/outbox`
 * Points to the first page; does not embed items inline (streaming-safe for large outboxes).
 */
export interface OrderedCollection {
  '@context': string
  type: 'OrderedCollection'
  id: string
  totalItems: number
  first: string
}

/**
 * AP OrderedCollectionPage — one page of the outbox.
 * id = `selfUrl ?? ${actorId}/outbox?page=true` — see buildOutboxPage JSDoc.
 * Each item is wrapped as a Create activity.
 * `next` is present only when a nextCursor is given.
 */
export interface OrderedCollectionPage {
  '@context': string
  type: 'OrderedCollectionPage'
  id: string
  partOf: string
  orderedItems: Create[]
  next?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build the top-level OrderedCollection descriptor for an actor's outbox.
 *
 * @param actorId      Full actor URL, e.g. https://serverless.social/ap/users/alice.example
 * @param total        Total number of items across all pages (reported as totalItems).
 * @param firstPageUrl URL of the first page — caller-supplied; builder stays pure.
 */
export function buildOutbox(
  actorId: string,
  total: number,
  firstPageUrl: string,
): OrderedCollection {
  return {
    '@context': AS_CONTEXT,
    type: 'OrderedCollection',
    id: `${actorId}/outbox`,
    totalItems: total,
    first: firstPageUrl,
  }
}

/**
 * Wrap a single content object as a Create activity.
 *
 * Extracted from buildOutboxPage for use by Task 7 deliver.ts, which needs a
 * clean single-item entry point to wrap outbound activities before delivery.
 *
 * @param actorId Full actor URL — becomes Create.actor.
 * @param item    Content object (ApNote | ApArticle) to wrap.
 * @returns       Create activity with id = `${item.id}/activity`, byte-identical
 *                to what buildOutboxPage produces inline.
 */
export function wrapCreate(actorId: string, item: ApOutboxItem): Create {
  return {
    // Create id is deterministic: object id + /activity suffix
    id: `${item.id}/activity`,
    type: 'Create',
    actor: actorId,
    object: item,
    to: item.to,
    cc: item.cc,
    published: item.published,
  }
}

/**
 * Wrap an edited content object as an Update. `activityId` must be unique per
 * edit and stable across redeliveries of the same stream record (the delivery
 * ledger keys on it). `published` is the edit time (`item.updated`, else the
 * item's own published time).
 */
export function wrapUpdate(
  actorId: string,
  item: ApOutboxItem,
  activityId: string,
): Update {
  return {
    id: activityId,
    type: 'Update',
    actor: actorId,
    object: item,
    to: item.to,
    cc: item.cc,
    published: item.updated ?? item.published,
  }
}

/** Wrap a removed object id as Delete(Tombstone) addressed like the original. */
export function wrapDelete(
  actorId: string,
  objectId: string,
  to: string[],
  cc: string[],
  activityId: string,
): Delete {
  return {
    id: activityId,
    type: 'Delete',
    actor: actorId,
    object: { id: objectId, type: 'Tombstone' },
    to,
    cc,
  }
}

/**
 * Build an OrderedCollectionPage for an actor's outbox.
 *
 * @param actorId     Full actor URL.
 * @param items       Content objects (ApNote | ApArticle) to include on this page.
 *                    Each is wrapped as a Create activity with id = `${item.id}/activity`.
 * @param nextCursor  Opaque cursor string for the next page. When provided, `next` is
 *                    set to `${actorId}/outbox?page=${encodeURIComponent(nextCursor)}`.
 *                    When absent, `next` is omitted entirely from the returned object.
 * @param selfUrl     The actual request URL for this page. The handler (Task 6) MUST
 *                    pass the real request URL here so each cursor page self-identifies
 *                    correctly (required for Mastodon AP traversal/dedup). When absent,
 *                    falls back to `${actorId}/outbox?page=true` for backward compatibility.
 *                    The builder stays pure/cursor-agnostic — it does NOT invent a cursor
 *                    scheme; the caller supplies selfUrl.
 */
export function buildOutboxPage(
  actorId: string,
  items: ApOutboxItem[],
  nextCursor?: string,
  selfUrl?: string,
): OrderedCollectionPage {
  const outboxId = `${actorId}/outbox`

  const orderedItems: Create[] = items.map(item => wrapCreate(actorId, item))

  const page: OrderedCollectionPage = {
    '@context': AS_CONTEXT,
    type: 'OrderedCollectionPage',
    // Page id: use caller-supplied selfUrl if provided (Task 6 requirement);
    // fall back to static default for backward compatibility.
    id: selfUrl ?? `${outboxId}?page=true`,
    partOf: outboxId,
    orderedItems,
  }

  // next is only present when a cursor is given — omit the key entirely otherwise
  if (nextCursor !== undefined) {
    page.next = `${outboxId}?page=${encodeURIComponent(nextCursor)}`
  }

  return page
}
