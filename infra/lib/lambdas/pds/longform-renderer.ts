import { renderArticleHtml, pickRelated, type AuthorProfile, type LongformContent, type RenderCtx } from './longform-render'
import { renderSitemap, renderRss, renderAtom } from './longform-feeds'
import { applyUpsert, applyDelete, toFeedItems, type IndexItem } from './longform-index'
import { renderIndexPage } from './longform-index-page'
import { buildBlueskySyndication } from './longform-syndication'
import { safeSlug } from './longform-routing'
import { APEX_DID } from './tenant-keys'
import { parseCustomHosts } from '../ap/host'
import type { CoverPreview } from './longform-preview'

/** Per-event tenant identity threaded into every tenant-sensitive Ports call.
 *  - apex (isApex:true, did:APEX_DID, s3Prefix:''): the Ports adapter MUST use
 *    the EXACT historical apex keys (DDB pk `'IDX'`, bare-slug KVS, getRecord
 *    repo = process.env.PDS_DID) so the live apex longform index / redirect
 *    map / repo fetch are byte-identical — changing them would corrupt
 *    existing apex data and break the apex byte-lock.
 *  - sub-tenant (isApex:false): the adapter namespaces by `did`/`s3Prefix`
 *    so tenants with identical rkey/slug never collide with apex or each other.
 *  Defaults to apex when omitted (back-compat for the pure processEvent tests). */
export interface TenantScope { did: string; isApex: boolean; s3Prefix: string }

const DEFAULT_APEX_SCOPE: TenantScope = { did: APEX_DID, isApex: true, s3Prefix: '' }

export interface Ports {
  prepareCover?(cover: string, siteOrigin: string, scope?: TenantScope): Promise<CoverPreview | undefined>
  /** The tenant's profile for the article's author card. */
  getProfile?(scope?: TenantScope): Promise<AuthorProfile | undefined>
  getRecord(rkey: string, scope?: TenantScope): Promise<(LongformContent & { syndicationTeaser?: string; syndicate?: boolean }) | undefined>
  putObject(key: string, body: string, contentType: string): Promise<void>
  deleteObject(key: string): Promise<void>
  listIndex(scope?: TenantScope): Promise<IndexItem[]>
  getIndex(rkey: string, scope?: TenantScope): Promise<IndexItem | undefined>
  putIndex(item: IndexItem, scope?: TenantScope): Promise<void>
  ownerOf(slug: string, scope?: TenantScope): Promise<string | undefined>
  kvsPut(slug: string, value: string, scope?: TenantScope): Promise<void>
  kvsDel(slug: string, scope?: TenantScope): Promise<void>
  syndicate(post: ReturnType<typeof buildBlueskySyndication>, scope?: TenantScope): Promise<{ uri: string; cid: string }>
  deleteSyndication(uri: string, scope?: TenantScope): Promise<void>
}
export interface RenderEvent { rkey: string; op: 'upsert' | 'delete'; cid?: string; did?: string }

const XML = 'application/xml; charset=utf-8'

async function writeFeeds(p: Ports, ctx: RenderCtx, pre: string, sc: TenantScope, overrideItems?: IndexItem[]): Promise<void> {
  const allIndex = overrideItems ?? await p.listIndex(sc)
  const items = toFeedItems(allIndex)
  await p.putObject(`${pre}sitemap.xml`, renderSitemap(items, ctx), XML)
  await p.putObject(`${pre}rss.xml`, renderRss(items, ctx), XML)
  await p.putObject(`${pre}atom.xml`, renderAtom(items, ctx), XML)
}

/** `s3Prefix` is `''` for apex (byte-identical keys) or `t/<handle>/` for a
 *  sub-tenant. `scope` carries the per-event tenant identity (did/isApex/
 *  s3Prefix) and is forwarded to every tenant-sensitive Ports call so that
 *  the DDB index pk, the KVS redirect/410 key, the getRecord repo and the
 *  syndication target are namespaced per tenant. For apex (`scope.isApex`)
 *  the Ports adapter MUST emit the EXACT historical apex keys (DDB pk
 *  `'IDX'`, bare-slug KVS, getRecord repo = process.env.PDS_DID) — apex
 *  index / redirect / repo state stays byte-identical. `scope` defaults to
 *  apex when omitted (pure-test back-compat). */
export async function processEvent(ev: RenderEvent, p: Ports, ctx: RenderCtx, s3Prefix = '', scope: TenantScope = DEFAULT_APEX_SCOPE): Promise<void> {
  const sc = scope
  const prev = await p.getIndex(ev.rkey, sc)
  const rec = ev.op === 'delete' ? undefined : await p.getRecord(ev.rkey, sc)

  if (!rec) {
    if (!prev || prev.status === 'deleted') return
    await p.deleteObject(`${s3Prefix}${prev.currentSlug}/index.html`)
    await p.kvsPut(prev.currentSlug, '410', sc)
    for (const s of prev.priorSlugs) {
      const o = await p.ownerOf(s, sc)
      if (!o || o === ev.rkey) await p.kvsPut(s, '410', sc)
    }
    if (prev.syndication.bsky) await p.deleteSyndication(prev.syndication.bsky.uri, sc)
    const deletedItem = applyDelete(prev)
    // Build feeds from the live index, replacing the deleted item in-memory
    const allIndex = await p.listIndex(sc)
    const updatedIndex = allIndex.map(i => i.rkey === deletedItem.rkey ? deletedItem : i)
    await writeFeeds(p, ctx, s3Prefix, sc, updatedIndex)
    // Non-apex only: re-render the tenant home page after a delete (published set changed)
    if (!sc.isApex) {
      await p.putObject(`${s3Prefix}index.html`, renderIndexPage(updatedIndex, ctx), 'text/html; charset=utf-8')
    }
    // Leave the index pending until all derived pages and feeds are written.
    // A retry after a failed write must still rerun the delete projection.
    await p.putIndex(deletedItem, sc)
    return
  }

  if (prev && prev.status === 'published' && ev.cid && prev.cid === ev.cid) return

  const cleanSlug = safeSlug(rec.slug)
  const owner = await p.ownerOf(cleanSlug, sc)
  const next = applyUpsert(prev, {
    rkey: ev.rkey, slug: cleanSlug, cid: ev.cid ?? 'unknown',
    title: rec.title, excerpt: rec.excerpt ?? '', tags: rec.tags ?? [], createdAt: rec.createdAt,
  }, (s) => (s === cleanSlug ? owner : undefined))

  // Task 15: the author card and related posts need the index and the profile.
  // The index list is read ONCE here and reused for the feeds below (it used to
  // be read after putIndex). The profile is one public getRecord; a failure
  // only drops the card's name/bio/avatar, never the post.
  const indexBefore = await p.listIndex(sc)
  let profile: AuthorProfile | undefined
  try { profile = p.getProfile ? await p.getProfile(sc) : undefined } catch (e) {
    console.error('[longform] getProfile failed (non-fatal)', e)
  }
  let coverPreview: CoverPreview | undefined
  if (rec.coverImage && p.prepareCover) {
    try { coverPreview = await p.prepareCover(rec.coverImage, ctx.origin, sc) } catch (error) {
      console.warn('[longform] cover preview unavailable', (error as Error).name)
    }
  }
  const related = pickRelated(indexBefore, { rkey: ev.rkey, slug: next.currentSlug, tags: rec.tags })

  await p.putObject(`${s3Prefix}${next.currentSlug}/index.html`,
    renderArticleHtml({
      ...rec,
      slug: next.currentSlug,
      syndication: next.syndication,
      authorHandle: ctx.author,
    }, { ...ctx, profile, related, coverPreview }), 'text/html; charset=utf-8')

  if (prev && prev.currentSlug && prev.currentSlug !== next.currentSlug) {
    await p.kvsPut(prev.currentSlug, `301 /${next.currentSlug}`, sc)
    await p.deleteObject(`${s3Prefix}${prev.currentSlug}/index.html`)
  }
  for (const s of next.priorSlugs) {
    const o = await p.ownerOf(s, sc)
    if (!o || o === ev.rkey) await p.kvsPut(s, `301 /${next.currentSlug}`, sc)
  }
  await p.kvsDel(next.currentSlug, sc)

  if (!next.syndication.bsky && rec.syndicate !== false) {
    try {
      const res = await p.syndicate(buildBlueskySyndication({ ...rec, slug: next.currentSlug }, ctx), sc)
      next.syndication = { bsky: res }
      // Persist the syndication result durably the moment it succeeds, not
      // only via the putIndex call below. This Lambda is DDB-stream-triggered
      // with retryAttempts:5 — if putIndex/writeFeeds/renderIndexPage throws
      // AFTER a successful syndicate() but BEFORE this had been recorded, the
      // whole invocation fails and the stream record retries; `prev` on retry
      // would then still show no syndication.bsky, and this branch would fire
      // syndicate() again, creating a second live Bluesky post for one
      // logical write (root cause of the 2026-05-22 6x apex duplicate-post
      // incident). Recording it here means any retry's `prev` reflects the
      // prior success and the guard above skips re-syndicating.
      await p.putIndex(next, sc)
      // The article above was rendered before the Bluesky post existed, so it
      // has no comments section (renderArticleHtml keys it on
      // syndication.bsky.uri). Render it once more now that it does; a reader
      // who publishes and opens the post gets the thread without waiting for
      // a later re-render.
      await p.putObject(`${s3Prefix}${next.currentSlug}/index.html`,
        renderArticleHtml({
          ...rec,
          slug: next.currentSlug,
          syndication: next.syndication,
          authorHandle: ctx.author,
        }, { ...ctx, profile, related, coverPreview }), 'text/html; charset=utf-8')
    } catch (e) {
      console.error('[longform] syndication failed (non-fatal)', e)
    }
  }

  await p.putIndex(next, sc)
  // Build feeds from the live index, replacing/inserting the upserted item in-memory
  const allIndex = indexBefore
  const exists = allIndex.some(i => i.rkey === next.rkey)
  const updatedIndex = exists ? allIndex.map(i => i.rkey === next.rkey ? next : i) : [...allIndex, next]
  await writeFeeds(p, ctx, s3Prefix, sc, updatedIndex)
  // Non-apex only: render the tenant home/index page (apex / MUST stay unchanged)
  if (!sc.isApex) {
    await p.putObject(`${s3Prefix}index.html`, renderIndexPage(updatedIndex, ctx), 'text/html; charset=utf-8')
  }
}

export async function handler(event: { Records: any[] }): Promise<void> {
  const { makeAwsPorts, eventsFromStream, makeRendererTenantStore, targetForRepo } =
    await import('./longform-renderer-aws.js')
  const ports = makeAwsPorts()
  const store = makeRendererTenantStore()
  for (const ev of eventsFromStream(event)) {
    // Apex events carry no `did` → targetForRepo resolves via the apex
    // short-circuit (no DDB read), s3Prefix:'' → byte-identical to before.
    const tgt = await targetForRepo(ev.did ?? '', store)
    const ctx = {
      origin: tgt.origin, siteName: tgt.siteName, author: tgt.author,
      apCustomHosts: parseCustomHosts(process.env.AP_CUSTOM_HOSTS),
    }
    // tgt.s3Prefix === '' iff renderTargetForTenant resolved apex (apex
    // short-circuit OR unknown/inactive sub-DID fallback). That is the
    // single authoritative apex signal: apex → DEFAULT apex scope (byte-
    // identical keys, getRecord repo = PDS_DID); sub-tenant → the event's
    // repo DID + its t/<handle>/ prefix so index/KVS/repo never collide.
    const isApex = tgt.s3Prefix === ''
    const scope: TenantScope = isApex
      ? DEFAULT_APEX_SCOPE
      : { did: ev.did!, isApex: false, s3Prefix: tgt.s3Prefix }
    await processEvent(ev, ports, ctx, tgt.s3Prefix, scope)
  }
}
