import type { FeedItem } from './longform-feeds'

export type ActivityPubLaunch = { text: string; publishedAt: string }

export interface IndexItem {
  rkey: string
  currentSlug: string
  priorSlugs: string[]
  status: 'published' | 'deleted'
  cid: string
  title: string
  excerpt: string
  tags: string[]
  createdAt: string
  publishedAt: string
  managedLaunch?: boolean
  launchActivityPub?: ActivityPubLaunch
  syndication: { bsky?: { uri: string; cid: string } }
}
export interface UpsertInput {
  rkey: string; slug: string; cid: string; title: string
  excerpt: string; tags: string[]; createdAt: string; managedLaunch?: boolean
}

/** owners(slug) → rkey currently owning that slug, or undefined. Used for collision auto-suffix. */
export function applyUpsert(
  prev: IndexItem | undefined,
  input: UpsertInput,
  owners: (slug: string) => string | undefined = () => undefined,
): IndexItem {
  let slug = input.slug
  const owner = owners(slug)
  if (owner && owner !== input.rkey) slug = `${slug}-2`
  const priorSet = new Set(prev?.priorSlugs ?? [])
  if (prev && prev.currentSlug && prev.currentSlug !== slug) priorSet.add(prev.currentSlug)
  priorSet.delete(slug)
  return {
    rkey: input.rkey,
    currentSlug: slug,
    priorSlugs: [...priorSet],
    status: 'published',
    cid: input.cid,
    title: input.title,
    excerpt: input.excerpt,
    tags: input.tags,
    createdAt: input.createdAt,
    publishedAt: prev?.publishedAt ?? new Date().toISOString(),
    ...(input.managedLaunch ? { managedLaunch: true } : {}),
    syndication: prev?.syndication ?? {},
  }
}

export function applyDelete(prev: IndexItem): IndexItem {
  return { ...prev, status: 'deleted' }
}

export function toFeedItems(items: IndexItem[]): FeedItem[] {
  return items
    .filter(i => i.status === 'published')
    .map(i => ({ slug: i.currentSlug, title: i.title, excerpt: i.excerpt, createdAt: i.createdAt }))
}

// Curated launches and renders update independent attributes. The merged
// article remains the common lookup for feeds, analytics and reply threads.
export function articleFromIndexRow(row: Record<string, unknown> | undefined): IndexItem | undefined {
  const item = row?.item as IndexItem | undefined
  if (!item || !item.managedLaunch) return item
  const bsky = row?.launchBluesky as IndexItem['syndication']['bsky']
  const ap = row?.launchActivityPub as ActivityPubLaunch | undefined
  return {
    ...item,
    ...(bsky ? { syndication: { ...item.syndication, bsky } } : {}),
    ...(ap ? { launchActivityPub: ap } : {}),
  }
}
