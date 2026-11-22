// Site-wide analytics overview: one window of page views across articles, the
// home page and short-post pages, compared with the previous window of equal
// length, plus where readers came from and how short posts are doing on
// Bluesky. Read-only, built entirely from existing PostAnalyticsTable rows
// (see rollup.ts for the row model) and the site's longform index.
//
// Only slugs that are published in the index count as article views, so
// scanner probes that the SPA fallback answers with 200 never reach the totals.

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DEVICES, SOURCES, type CityViews, type Device, type InsightArticle, type InsightSite, type OverviewPost, type SiteOverview, type Source, type ViewTotals } from "../../../insights";
import { articleFromIndexRow, type IndexItem } from "../pds/longform-index";
import { blueskyLink } from "./reply-actions";
import { edgeCity, edgeCountry } from "./edge-locations";
import { trendDays } from "./workspace-trends";

type Doc = { send: (command: any) => Promise<any> };
export type OverviewDeps = {
  ddb: Doc;
  analyticsTable: string;
  indexTable: string;
  apexDid: string;
  fetch?: typeof fetch;
  now?: number;
};

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const postCollection = "app.bsky.feed.post";
const recentPosts = 30;
const concurrency = 8;

async function queryAll(deps: OverviewDeps, table: string, pk: string, range?: [string, string]) {
  const items: Record<string, any>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await deps.ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: range ? "pk = :pk AND sk BETWEEN :start AND :end" : "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk, ...(range ? { ":start": range[0], ":end": range[1] } : {}) },
      ExclusiveStartKey: cursor,
    }));
    items.push(...(page?.Items ?? []));
    cursor = page?.LastEvaluatedKey;
  } while (cursor && items.length < 20_000);
  return items;
}

async function pool<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  }));
  return out;
}

/** Running sums of the attribution counters on human rows. */
export class Tally {
  sources: Partial<Record<Source, number>> = {};
  devices: Partial<Record<Device, number>> = {};
  countries = new Map<string, number>();
  edges = new Map<string, number>();
  referrers = new Map<string, number>();
  automated = 0;

  addRow(row: Record<string, unknown>) {
    this.automated += count(row.uaBot);
    for (const [name, value] of Object.entries(row)) {
      const n = count(value);
      if (!n) continue;
      if (name.startsWith("source_")) {
        const key = name.slice(7) as Source;
        if (Object.hasOwn(SOURCES, key)) this.sources[key] = (this.sources[key] ?? 0) + n;
      } else if (name.startsWith("device_")) {
        const key = name.slice(7) as Device;
        if (Object.hasOwn(DEVICES, key)) this.devices[key] = (this.devices[key] ?? 0) + n;
      } else if (/^geo_[A-Z]{2}$/.test(name)) {
        this.countries.set(name.slice(4), (this.countries.get(name.slice(4)) ?? 0) + n);
      } else if (/^edge_[A-Z]{3}$/.test(name)) {
        this.edges.set(name.slice(5), (this.edges.get(name.slice(5)) ?? 0) + n);
      }
    }
  }

  addReferrer(sk: string, n: unknown) {
    const host = sk.replace(/^REF#\d{4}-\d{2}-\d{2}#/, "");
    if (host !== "direct" && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return;
    this.referrers.set(host, (this.referrers.get(host) ?? 0) + count(n));
  }

  countryList() { return ranked(this.countries).map(([code, views]) => ({ code, views })); }
  cityList(limit = 12): CityViews[] {
    return ranked(this.edges).slice(0, limit).map(([code, views]) => {
      const city = edgeCity(code);
      return { code, ...(city ? { city } : {}), country: edgeCountry(code), views };
    });
  }
  referrerList(limit = 15, exclude?: string) {
    return ranked(this.referrers).filter(([host]) => host !== exclude).slice(0, limit).map(([host, views]) => ({ host, views }));
  }
}

function ranked(map: Map<string, number>) {
  return [...map.entries()].filter(([, n]) => n > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

/** Latest snapshot and the change across the window for cumulative series. */
export function snapshotChange(rows: Record<string, unknown>[], metric: (row: Record<string, unknown>) => number | undefined,
  first: string, last: string, startsInWindow: boolean) {
  const series = rows
    .filter(row => typeof row.sk === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.sk) && row.sk <= last)
    .map(row => ({ day: row.sk as string, value: metric(row) }))
    .filter((point): point is { day: string; value: number } => point.value !== undefined)
    .sort((a, b) => a.day.localeCompare(b.day));
  const latest = series.at(-1);
  if (!latest) return undefined;
  const before = series.filter(point => point.day < first).at(-1);
  const baseline = before?.value ?? (startsInWindow ? 0 : series.find(point => point.day >= first)?.value ?? latest.value);
  return { latest: latest.value, change: latest.value - baseline, day: latest.day };
}

const engagement = (row: Record<string, unknown>) => {
  const parts = [row.likes, row.reposts, row.replies];
  return parts.every(value => typeof value === "number") ? parts.reduce<number>((sum, value) => sum + count(value), 0) : undefined;
};

function published(item: IndexItem | undefined, site: InsightSite): InsightArticle | undefined {
  if (item?.status !== "published" || !/^[a-z0-9-]+$/.test(item.currentSlug ?? "")) return;
  const blueskyUrl = blueskyLink(item.syndication?.bsky?.uri ?? "");
  return {
    rkey: item.rkey, title: item.title, url: `https://${site.host}/${item.currentSlug}`, publishedAt: item.publishedAt,
    ...(blueskyUrl ? { blueskyUrl } : {}),
  };
}

type PostRecord = { rkey: string; text: string; url: string; publishedAt?: string; uri: string };
async function listPosts(deps: OverviewDeps, site: InsightSite): Promise<PostRecord[]> {
  const url = new URL(`https://${site.host}/xrpc/com.atproto.repo.listRecords`);
  url.search = new URLSearchParams({ repo: site.did, collection: postCollection, limit: String(recentPosts) }).toString();
  const response = await (deps.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) return [];
  const page = await response.json() as { records?: { uri?: string; value?: { text?: string; createdAt?: string } }[] };
  const prefix = `at://${site.did}/${postCollection}/`;
  return (Array.isArray(page.records) ? page.records : []).flatMap(record => {
    const uri = record?.uri;
    if (typeof uri !== "string" || !uri.startsWith(prefix)) return [];
    const link = blueskyLink(uri);
    if (!link) return [];
    const text = typeof record.value?.text === "string" ? record.value.text.trim().slice(0, 160) : "";
    const createdAt = record.value?.createdAt;
    return [{ rkey: uri.slice(prefix.length), uri, url: link, text: text || "Media post",
      ...(typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt)) ? { publishedAt: createdAt } : {}) }];
  });
}

async function getPost(deps: OverviewDeps, site: InsightSite, rkey: string) {
  const url = new URL(`https://${site.host}/xrpc/com.atproto.repo.getRecord`);
  url.search = new URLSearchParams({ repo: site.did, collection: postCollection, rkey }).toString();
  const response = await (deps.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(4000) });
  if (!response.ok) return undefined;
  const body = await response.json() as { value?: { text?: string; createdAt?: string } };
  const text = typeof body.value?.text === "string" ? body.value.text.trim().slice(0, 160) : "";
  const createdAt = body.value?.createdAt;
  return { text: text || "Media post", publishedAt: typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt)) ? createdAt : undefined };
}

export async function buildSiteOverview(deps: OverviewDeps, site: InsightSite, range: number): Promise<SiteOverview> {
  const span = trendDays(range * 2, deps.now);
  const previousDays = span.slice(0, range);
  const days = span.slice(range);
  const [prevFirst, first, last] = [previousDays[0], days[0], days[days.length - 1]];
  const host = site.host.toLowerCase().replace(/^www\./, "");
  const zero = (): ViewTotals => ({ articles: 0, home: 0, posts: 0 });
  const totals = zero();
  const previous = zero();
  const daily = new Map(days.map(day => [day, { day, ...zero() }]));
  const tally = new Tally();
  const add = (kind: keyof ViewTotals, row: Record<string, unknown>, day: string) => {
    const views = count(row.views);
    if (day >= first && day <= last) {
      totals[kind] += views;
      daily.get(day)![kind] += views;
      tally.addRow(row);
    } else if (day >= prevFirst && day < first) {
      previous[kind] += views;
    }
  };

  // Articles: every published entry in the site's index.
  const indexPk = site.did === deps.apexDid ? "IDX" : `IDX#${site.did}`;
  const indexRows = await queryAll(deps, deps.indexTable, indexPk);
  const articles = indexRows.flatMap(row => {
    const item = articleFromIndexRow(row);
    const article = published(item, site);
    return article && item ? [{ article, slug: item.currentSlug }] : [];
  });
  const articleStats = await pool(articles, async ({ article, slug }) => {
    const pk = `VIEW#${host}#${slug}`;
    const [rows, refs] = await Promise.all([
      queryAll(deps, deps.analyticsTable, pk, [prevFirst, last]),
      queryAll(deps, deps.analyticsTable, pk, [`REF#${first}#`, `REF#${last}#~`]),
    ]);
    let views = 0;
    let before = 0;
    for (const row of rows) {
      add("articles", row, row.sk);
      if (row.sk >= first) views += count(row.views); else before += count(row.views);
    }
    for (const row of refs) tally.addReferrer(row.sk, row.count);
    return { ...article, views, previous: before };
  });

  // Home page.
  const [homeRows, homeRefs] = await Promise.all([
    queryAll(deps, deps.analyticsTable, `HOME#${host}`, [prevFirst, last]),
    queryAll(deps, deps.analyticsTable, `HOME#${host}`, [`REF#${first}#`, `REF#${last}#~`]),
  ]);
  for (const row of homeRows) add("home", row, row.sk);
  for (const row of homeRefs) tally.addReferrer(row.sk, row.count);

  // Short-post pages on this site, for the site's own account only.
  const actors = new Set([site.handle.toLowerCase(), site.did.toLowerCase()]);
  const postViews = new Map<string, number>();
  for (const row of await queryAll(deps, deps.analyticsTable, `POSTVIEW#${host}`, [prevFirst, `${last}#~`])) {
    const [day, actor, rkey] = String(row.sk).split("#");
    if (!actors.has(actor) || !rkey) continue;
    add("posts", row, day);
    if (day >= first) postViews.set(rkey, (postViews.get(rkey) ?? 0) + count(row.views));
  }

  // Short posts: recent posts plus any that drew page views, with their Bluesky engagement.
  const recent = await listPosts(deps, site).catch(() => [] as PostRecord[]);
  const known = new Map(recent.map(post => [post.rkey, post]));
  for (const rkey of postViews.keys()) {
    if (known.has(rkey)) continue;
    const uri = `at://${site.did}/${postCollection}/${rkey}`;
    const url = blueskyLink(uri);
    if (url) known.set(rkey, { rkey, uri, url, text: "Short post" });
  }
  const posts = await pool([...known.values()], async (post): Promise<OverviewPost> => {
    const rows = await queryAll(deps, deps.analyticsTable, `ENGAGE#${post.uri}`, [prevFirst, last]);
    const fresh = (post.publishedAt ?? "").slice(0, 10) >= first;
    const change = snapshotChange(rows, engagement, first, last, fresh);
    return {
      rkey: post.rkey, text: post.text, url: post.url, ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
      views: postViews.get(post.rkey) ?? 0,
      ...(change ? { engagement: change.latest, engagementGain: change.change } : {}),
    };
  });

  const topPosts = posts.filter(post => post.views || post.engagementGain)
    .sort((a, b) => (b.views - a.views) || ((b.engagementGain ?? 0) - (a.engagementGain ?? 0))).slice(0, 10);
  await Promise.all(topPosts.filter(post => !known.get(post.rkey)?.publishedAt).map(async post => {
    const record = await getPost(deps, site, post.rkey).catch(() => undefined);
    if (record?.text) post.text = record.text;
    if (record?.publishedAt) post.publishedAt = record.publishedAt;
  }));

  const [followerRows, meta] = await Promise.all([
    queryAll(deps, deps.analyticsTable, `ACCT#${site.did}`, [prevFirst, last]),
    deps.ddb.send(new GetCommand({ TableName: deps.analyticsTable, Key: { pk: "META#analytics", sk: "reprocessed" } })).catch(() => undefined),
  ]);
  const cleanFrom = typeof meta?.Item?.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meta.Item.from) ? meta.Item.from : undefined;
  const followers = snapshotChange(followerRows, row => typeof row.followers === "number" ? row.followers : undefined, first, last, false);

  return {
    days,
    totals,
    previous,
    automated: tally.automated,
    daily: [...daily.values()],
    articleCount: articles.length,
    topArticles: articleStats.filter(article => article.views || article.previous)
      .sort((a, b) => b.views - a.views || b.previous - a.previous || a.title.localeCompare(b.title)).slice(0, 10),
    topPosts,
    sources: tally.sources,
    devices: tally.devices,
    countries: tally.countryList(),
    cities: tally.cityList(),
    referrers: tally.referrerList(15, host),
    ...(cleanFrom ? { cleanFrom } : {}),
    ...(followers ? { followers: { count: followers.latest, change: followers.change, day: followers.day } } : {}),
  };
}
