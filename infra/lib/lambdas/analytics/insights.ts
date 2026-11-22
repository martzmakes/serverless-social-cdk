import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { isIP } from "node:net";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DEVICES, SOURCES, type ArticleDistribution, type ArticleInsights, type ArticleReplies, type InsightArticle, type InsightSite, type ReplyQueuePage, type TrendKind, type TrendPage } from "../../../insights";
import { resolveApprovedDids } from "../auth/entitlements";
import { canShare, readSharing, saveSharing, sharingHosts, workspaceHost, workspaceSites } from "../auth/site-sharing";
import { verifyJwt } from "../auth/lib/jwt";
import { articleRepliesPartition, type TimelineItem } from "../ap/ingest";
import { safeHttpsUrl } from "../ap/sanitize";
import { canonicalApOrigin, parseCustomHosts } from "../ap/host";
import { applyReplyAction, blueskyLink, readHandled, readReplyAction, ReplyActionError } from "./reply-actions";
import { articleFromIndexRow, type IndexItem } from "../pds/longform-index";
import { trendDays, trendValues } from "./workspace-trends";
import { buildSiteOverview, Tally } from "./site-overview";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const domain = process.env.DOMAIN!;
const apexHandle = process.env.PDS_HANDLE ?? domain;
const apexDid = `did:web:${apexHandle}`;
const indexTable = process.env.LONGFORM_INDEX_TABLE!;
const analyticsTable = process.env.POST_ANALYTICS_TABLE!;
const tenantHosts = new Set((process.env.KNOWN_TENANT_HOSTS ?? "").split(",").filter(Boolean));
const inboundTable = process.env.AP_INBOUND_TABLE!;
const siteBucket = process.env.SITE_BUCKET!;
const apHosts = parseCustomHosts(process.env.AP_CUSTOM_HOSTS);
const entitlements = {
  ddb,
  apexDid,
  apexHandle,
  tenantsTable: process.env.TENANTS_TABLE!,
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "").split(",").map(email => email.trim()).filter(Boolean),
};
const sharing = {
  domain, apexDid, ddb, table: process.env.SITE_SHARING_TABLE,
  hosts: sharingHosts(domain, process.env.KNOWN_TENANT_HOSTS),
};
const replyContext = {
  entitlements, analyticsTable, inboundTable, apiOrigin: process.env.REPLY_API_ORIGIN!,
};
const recordKey = /^(?!\.{1,2}$)[A-Za-z0-9._~:-]{1,512}$/;
const MS_PER_DAY = 86_400_000;
const base = "/auth/insights";

function json(statusCode: number, value: unknown) {
  return {
    statusCode,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(value),
  };
}

const bskyUri = /^at:\/\/(did:[a-z]+:[a-z0-9.:%-]+)\/app\.bsky\.feed\.post\/([a-z0-9._~:-]+)$/i;
function getArticle(item: IndexItem | undefined, site: InsightSite): InsightArticle | undefined {
  if (item?.status !== "published" || !/^[a-z0-9-]+$/.test(item.currentSlug)) return;
  const blueskyUrl = blueskyLink(item.syndication?.bsky?.uri ?? "");
  return {
    rkey: item.rkey,
    title: item.title,
    url: `https://${site.host}/${item.currentSlug}`,
    publishedAt: item.publishedAt,
    ...(blueskyUrl ? { blueskyUrl } : {}),
  };
}

function isoDay(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Inspect the generated head. The canonical article always supplies the
// lookup key, so the caller cannot request arbitrary bucket objects or URLs.
async function socialCard(site: InsightSite, slug: string): Promise<ArticleDistribution["socialCard"]> {
  const prefix = site.did === apexDid ? "" : `t/${site.host}/`;
  const object = await s3.send(new GetObjectCommand({
    Bucket: siteBucket,
    Key: `${prefix}${slug}/index.html`,
    Range: "bytes=0-65535",
  }));
  const html = await object.Body?.transformToString();
  if (!html) return;
  const document = parse(html);
  const root = document.childNodes.find(node => node.nodeName === "html");
  const head = root && "childNodes" in root && root.childNodes.find(node => node.nodeName === "head");
  if (!head || !("childNodes" in head)) return;
  const tags = new Map<string, string>();
  for (const node of head.childNodes) {
    if (node.nodeName !== "meta" || !("attrs" in node)) continue;
    const name = node.attrs.find(attr => attr.name === "property")?.value;
    const value = node.attrs.find(attr => attr.name === "content")?.value;
    if (name && value && !tags.has(name)) tags.set(name, value);
  }
  const title = tags.get("og:title");
  if (!title) return;
  const optionalText = (name: string) => tags.get(name);
  const description = optionalText("og:description");
  const imageAlt = optionalText("og:image:alt");
  let image: string | undefined;
  try {
    const candidate = new URL(tags.get("og:image") ?? "");
    if (candidate.protocol === "https:" && !candidate.username && !candidate.password) image = candidate.href;
  } catch {
    // The card can still show its title and description.
  }
  return { title, description, image, imageAlt };
}

async function latestEngagement(uri: string): Promise<ArticleDistribution["bluesky"]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: analyticsTable,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `ENGAGE#${uri}` },
    ScanIndexForward: false,
    Limit: 1,
  }));
  const row = Items?.[0];
  if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.sk)) return;
  return { day: row.sk, likes: count(row.likes), replies: count(row.replies), reposts: count(row.reposts) };
}

async function distribution(site: InsightSite, item: IndexItem, article: InsightArticle): Promise<ArticleDistribution> {
  const host = canonicalApOrigin(site.handle, apHosts);
  const activityPubUrl = `${host}/ap/users/${encodeURIComponent(site.handle)}/articles/${encodeURIComponent(article.rkey)}`;
  const [card, engagement] = await Promise.allSettled([
    socialCard(site, item.currentSlug),
    article.blueskyUrl && item.syndication?.bsky?.uri ? latestEngagement(item.syndication.bsky.uri) : undefined,
  ]);
  return {
    activityPubUrl,
    ...(card.status === "fulfilled" && card.value ? { socialCard: card.value } : {}),
    ...(engagement.status === "fulfilled" && engagement.value ? { bluesky: engagement.value } : {}),
  };
}

type Thread = {
  $type?: string;
  post?: { uri?: string; author?: { handle?: string }; record?: { text?: string; createdAt?: string } };
  replies?: Thread[];
};

async function blueskyReplies(uri: string, ownHandle: string): Promise<ArticleReplies["replies"]> {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread");
  url.search = new URLSearchParams({ uri, depth: "2", parentHeight: "0" }).toString();
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(4_000) });
  const payload = await response.json() as { thread?: Thread; error?: string };
  if (response.status === 404 || payload.error === "NotFound") return [];
  if (!response.ok) throw new Error("Bluesky thread unavailable");
  const replies: ArticleReplies["replies"] = [];
  function add(node: Thread, depth: number) {
    if (depth > 2 || replies.length >= 100 || !node.post) return;
    const { uri, author, record } = node.post;
    const link = typeof uri === "string" && blueskyLink(uri);
    if (uri && link && author?.handle && author.handle !== ownHandle &&
        typeof record?.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))) {
      replies.push({ id: uri, author: author.handle, network: "Bluesky", publishedAt: record.createdAt, url: link,
        text: typeof record.text === "string" ? record.text.slice(0, 8_000) : "" });
    }
    if (Array.isArray(node.replies)) node.replies.forEach(child => add(child, depth + 1));
  }
  if (Array.isArray(payload.thread?.replies)) payload.thread.replies.forEach(node => add(node, 1));
  return replies;
}

function plainText(node: DefaultTreeAdapterTypes.Node): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (node.nodeName === "br") return "\n";
  const value = "childNodes" in node ? node.childNodes.map(plainText).join("") : "";
  return node.nodeName === "p" || node.nodeName === "li" ? `${value}\n` : value;
}

async function fediverseReplies(site: InsightSite, rkey: string, after?: string) {
  const prefix = `${rkey}#`;
  const { Items, LastEvaluatedKey } = await ddb.send(new QueryCommand({
    TableName: inboundTable,
    IndexName: "byPublished",
    KeyConditionExpression: after ? "pk = :pk AND sortKey BETWEEN :first AND :last" : "pk = :pk AND begins_with(sortKey, :first)",
    ExpressionAttributeValues: { ":pk": articleRepliesPartition(site.handle), ":first": prefix, ...(after ? { ":last": after } : {}) },
    ScanIndexForward: false, Limit: after ? 31 : 30,
  }));
  const now = Math.floor(Date.now() / 1000);
  const replies: ArticleReplies["replies"] = [];
  for (const row of Items ?? []) {
    if (row.sortKey === after || row.ttl <= now) continue;
    const item = row.item as TimelineItem;
    const url = safeHttpsUrl(item.url);
    if (!url) continue;
    replies.push({ id: item.id, network: "Fediverse", author: item.actor.handle, url, publishedAt: item.published,
      text: plainText(parseFragment(item.content)).trim().slice(0, 8_000) });
  }
  return { replies, next: typeof LastEvaluatedKey?.sortKey === "string" ? LastEvaluatedKey.sortKey : undefined };
}

async function articleReplies(site: InsightSite, item: IndexItem, after?: string): Promise<ArticleReplies> {
  const uri = item.syndication?.bsky?.uri;
  const [bsky, fedi] = await Promise.allSettled([
    !after && uri && bskyUri.test(uri) ? blueskyReplies(uri, site.handle) : [],
    fediverseReplies(site, item.rkey, after),
  ]);
  const replies: ArticleReplies["replies"] = [];
  const unavailable: ArticleReplies["unavailable"] = [];
  if (bsky.status === "fulfilled") replies.push(...bsky.value);
  else unavailable.push("Bluesky");
  if (fedi.status === "fulfilled") replies.push(...fedi.value.replies);
  else unavailable.push("Fediverse");
  replies.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { replies, unavailable, ...(fedi.status === "fulfilled" ? { next: fedi.value.next } : {}) };
}

async function articleIndexPage(pk: string, limit: number, after?: string) {
  return ddb.send(new QueryCommand({
    TableName: indexTable,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": pk },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: after ? { pk, sk: after } : undefined,
  }));
}

const trendPageSize = 12;
const trendPostCollection = "app.bsky.feed.post";

async function trendSeries(kind: TrendKind, pk: string, days: string[], publishedAt: string) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: analyticsTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
    ExpressionAttributeValues: { ":pk": pk, ":start": days[0], ":end": days[days.length - 1] },
    ProjectionExpression: "sk, #views, #likes, #reposts, #replies",
    ExpressionAttributeNames: { "#views": "views", "#likes": "likes", "#reposts": "reposts", "#replies": "replies" },
  }));
  return trendValues(kind, days, publishedAt, Items ?? []);
}

async function postTrends(site: InsightSite, days: string[], after?: string): Promise<TrendPage> {
  const list = new URL("https://" + site.host + "/xrpc/com.atproto.repo.listRecords");
  list.search = new URLSearchParams({
    repo: site.did, collection: trendPostCollection, limit: String(trendPageSize), ...(after ? { cursor: after } : {}),
  }).toString();
  const result = await fetch(list, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!result.ok) throw new Error("The site's short posts are unavailable.");
  const page = await result.json() as { records?: { uri?: string; value?: { text?: string; createdAt?: string } }[]; cursor?: string };
  if (!Array.isArray(page.records)) throw new Error("Invalid short post response.");
  const prefix = `at://${site.did}/${trendPostCollection}/`;
  const items = await Promise.all(page.records.slice(0, trendPageSize).flatMap(record => {
    const uri = record?.uri;
    if (typeof uri !== "string" || !uri.startsWith(prefix)) return [];
    const rkey = uri.slice(prefix.length);
    if (!recordKey.test(rkey)) return [];
    const url = blueskyLink(uri);
    if (!url) return [];
    const publishedAt = typeof record.value?.createdAt === "string" ? record.value.createdAt : "";
    const title = typeof record.value?.text === "string" ? record.value.text.trim().slice(0, 160) : "";
    return [trendSeries("post", `ENGAGE#${uri}`, days, publishedAt)
      .then(values => ({ rkey, title: title || "Media post", url, publishedAt, values }))];
  }));
  return { days, items, ...(typeof page.cursor === "string" && recordKey.test(page.cursor) ? { next: page.cursor } : {}) };
}

async function workspaceTrends(site: InsightSite, indexPk: string, kind: TrendKind, range: number, after?: string): Promise<TrendPage> {
  const days = trendDays(range);
  if (kind === "post") return postTrends(site, days, after);
  const page = await articleIndexPage(indexPk, trendPageSize, after);
  const host = site.host.toLowerCase().replace(/^www\./, "");
  const items = await Promise.all((page.Items ?? []).flatMap(row => {
    const item = articleFromIndexRow(row);
    const article = getArticle(item, site);
    if (!item || !article) return [];
    return [trendSeries("article", `VIEW#${host}#${item.currentSlug}`, days, article.publishedAt)
      .then(values => ({ ...article, values }))];
  }));
  return { days, items, next: page.LastEvaluatedKey?.sk };
}

async function replyQueue(site: InsightSite, pk: string, after?: string): Promise<ReplyQueuePage> {
  // Each request reads one bounded page of the site's publication index. It
  // uses the same two live sources and state as an individual conversation.
  const page = await articleIndexPage(pk, 8, after);
  const threads = await Promise.all((page.Items ?? []).flatMap(row => {
    const item = articleFromIndexRow(row);
    const article = getArticle(item, site);
    if (!item || !article) return [];
    return [(async () => {
      const conversation = await articleReplies(site, item);
      const replies = await readHandled(replyContext, site.did, item.rkey, conversation.replies);
      return {
        ...conversation,
        article,
        replies: replies.map(reply => ({
          ...reply,
          text: reply.text.length > 500 ? reply.text.slice(0, 500).trimEnd() + "…" : reply.text,
        })),
      };
    })()];
  }));
  return {
    threads: threads.filter(thread => thread.replies.length || thread.unavailable.length || thread.next),
    next: page.LastEvaluatedKey?.sk,
  };
}

async function report(site: InsightSite, item: IndexItem, article: InsightArticle, days: number): Promise<ArticleInsights> {
  const today = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
  const filteredDays = Array.from({ length: days }, (_, i) => isoDay(today - (days - 1 - i) * MS_PER_DAY));
  const last = filteredDays[days - 1];
  const published = (item.publishedAt ?? "").slice(0, 10);
  const first = /^\d{4}-\d{2}-\d{2}$/.test(published) && published > filteredDays[0] ? published : filteredDays[0];
  const host = site.host.toLowerCase().replace(/^www\./, "");
  const pk = `VIEW#${host}#${item.currentSlug}`;
  const daily: ArticleInsights["daily"] = filteredDays.map(day => ({ day, views: 0 }));
  const sources: ArticleInsights["sources"] = {};
  const devices: ArticleInsights["devices"] = {};
  let views = 0;
  let classifiedViews = 0;
  const referrers = new Map<string, number>();
  const geo = new Tally();
  const queryRange = (start: string, end: string, cursor?: Record<string, unknown>) => ddb.send(new QueryCommand({
    TableName: analyticsTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
    ExpressionAttributeValues: { ":pk": pk, ":start": start, ":end": end },
    ExclusiveStartKey: cursor,
  }));

  if (first <= last) {
    // At most 90 rows. The referrer range has its own sort-key prefix.
    const rows = await queryRange(first, last);
    const byDay = new Map(daily.map(row => [row.day, row]));
    for (const row of rows.Items ?? []) {
      const day = byDay.get(row.sk);
      if (!day) continue;
      day.views = count(row.views);
      views += day.views;
      classifiedViews += count(row.classifiedViews);
      geo.addRow(row);
      for (const key of Object.keys(SOURCES) as (keyof typeof SOURCES)[]) {
        const n = count(row[`source_${key}`]);
        if (n) sources[key] = (sources[key] ?? 0) + n;
      }
      for (const key of Object.keys(DEVICES) as (keyof typeof DEVICES)[]) {
        const n = count(row[`device_${key}`]);
        if (n) devices[key] = (devices[key] ?? 0) + n;
      }
    }

    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await queryRange(`REF#${first}#`, `REF#${last}#~`, cursor);
      for (const row of page.Items ?? []) {
        const host = String(row.sk).slice("REF#0000-00-00#".length);
        if (host !== "direct" && (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || isIP(host))) continue;
        referrers.set(host, (referrers.get(host) ?? 0) + count(row.count));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
  }

  return {
    article, views, classifiedViews, daily, sources, devices,
    referrers: [...referrers.entries()]
      .sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b))
      .slice(0, 10)
      .map(([host, views]) => ({ host, views })),
    countries: geo.countryList(),
    cities: geo.cityList(8),
  };
}

export async function handler(event: APIGatewayProxyEventV2) {
  const bearer = /^Bearer (\S+)$/i.exec(event.headers.authorization ?? "");
  const session = bearer && await verifyJwt(bearer[1]).catch(() => undefined);
  if (!session) return json(401, { message: "Sign in to view article analytics." });
  const path = event.rawPath.replace(/\/$/, "");
  const method = event.requestContext?.http?.method ?? "GET";
  const sharingPath = path === `${base}/sharing`;
  const articleAction = path.startsWith(`${base}/articles/`) && path.endsWith("/replies");
  if (method !== "GET" && !(method === "POST" && (sharingPath || articleAction))) {
    return json(405, { message: "Unsupported article action." });
  }
  const overviewPath = path === `${base}/overview`;
  if (path !== base && !sharingPath && !overviewPath && path !== `${base}/replies` && !path.startsWith(`${base}/articles`)) {
    return json(404, { message: "Analytics route unavailable." });
  }
  const host = workspaceHost(session, event.headers["x-pds-viewer-host"], sharing);
  if (!host) return json(403, { message: "Sign in on this site to open its workspace." });

  try {
    const approved = await resolveApprovedDids(session.email, entitlements);
    const sites: InsightSite[] = approved.flatMap(({ did, handle }) => {
      if (did === apexDid) return [{ did, handle, host: domain }];
      return handle !== domain && tenantHosts.has(handle) ? [{ did, handle, host: handle }] : [];
    });
    if (sharingPath) {
      if (!sites.some(site => site.host === host)) return json(403, { message: "Only this site’s owner can change its sharing settings." });
      if (method === "POST") {
        if (session.siteHost !== host) return json(403, { message: "Sign in again on this site before changing its sharing settings." });
        if (Buffer.byteLength(event.body ?? "") > 1000) return json(413, { message: "Sharing settings are too large." });
        let input: { peer?: unknown; incoming?: unknown; outgoing?: unknown } | undefined;
        try { input = JSON.parse(event.body ?? ""); } catch { /* Invalid input is handled below. */ }
        const { peer, incoming, outgoing } = input ?? {};
        if (typeof peer !== "string" || peer === host || !sharing.hosts.has(peer) ||
            typeof incoming !== "boolean" || typeof outgoing !== "boolean") {
          return json(400, { message: "Choose a connected site and both sharing directions." });
        }
        await saveSharing(sharing, host, peer, { incoming, outgoing });
        return json(200, { incoming, outgoing });
      }
      const peers = await Promise.all([...sharing.hosts].filter(peer => peer !== host)
        .map(async peer => ({ host: peer, ...await readSharing(sharing, host, peer) })));
      return json(200, { host, peers });
    }
    if (path === base) return json(200, { sites: await workspaceSites(sharing, sites, host) });

    const params = event.queryStringParameters ?? {};
    const site = sites.find(candidate => candidate.did === params.did);
    if (!site) return json(403, { message: "This session cannot view analytics for the selected site." });
    if (!await canShare(sharing, site.host, host)) return json(403, { message: "The selected site’s content is unavailable in this workspace." });
    const pk = site.did === apexDid ? "IDX" : `IDX#${site.did}`;
    if (overviewPath) {
      const range = params.days ?? "30";
      if (!["7", "30", "90"].includes(range)) return json(400, { message: "Select 7, 30, or 90 days." });
      return json(200, await buildSiteOverview({ ddb, analyticsTable, indexTable, apexDid }, site, Number(range)));
    }
    if (path === `${base}/articles` || path === `${base}/replies`) {
      if (params.after !== undefined && !recordKey.test(params.after)) return json(400, { message: "Invalid article cursor." });
      if (path === `${base}/replies`) return json(200, await replyQueue(site, pk, params.after));
      if (params.trend !== undefined) {
        const range = params.days ?? "30";
        if ((params.trend !== "article" && params.trend !== "post") || !["7", "30", "90"].includes(range)) {
          return json(400, { message: "Choose articles or short posts and a range of 7, 30, or 90 days." });
        }
        return json(200, await workspaceTrends(site, pk, params.trend, Number(range), params.after));
      }
      const result = await articleIndexPage(pk, 30, params.after);
      const articles = (result.Items ?? []).flatMap(row => {
        const article = getArticle(articleFromIndexRow(row), site);
        return article ? [article] : [];
      });
      return json(200, { articles, next: result.LastEvaluatedKey?.sk });
    }
    const rkey = event.pathParameters?.rkey;
    const isDistribution = path.endsWith("/distribution");
    const isReplies = path.endsWith("/replies");
    const days = params.days ?? "30";
    if (!rkey || !recordKey.test(rkey)) return json(404, { message: "This article is unavailable." });
    if (!isDistribution && !isReplies && !["7", "30", "90"].includes(days)) return json(400, { message: "Select 7, 30, or 90 days." });

    const result = await ddb.send(new GetCommand({ TableName: indexTable, Key: { pk, sk: rkey }, ConsistentRead: true }));
    const item = articleFromIndexRow(result.Item);
    const article = getArticle(item, site);
    if (!item || !article) return json(404, { message: "This article is unavailable." });
    if (isReplies) {
      if (method === "POST") {
        if (event.body && Buffer.byteLength(event.body) > 7000) return json(413, { message: "Reply request too large." });
        let payload: unknown;
        try {
          payload = JSON.parse(event.body ?? "");
        } catch {
          return json(400, { message: "Enter a valid reply action." });
        }
        return json(200, await applyReplyAction(replyContext, session.email, site, item, readReplyAction(payload)));
      }
      const after = params.after;
      if (after && (!after.startsWith(`${rkey}#`) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[a-f0-9]{16}$/.test(after.slice(rkey.length + 1)))) {
        return json(400, { message: "Invalid reply cursor." });
      }
      const page = await articleReplies(site, item, after);
      return json(200, { ...page, replies: await readHandled(replyContext, site.did, item.rkey, page.replies) });
    }
    return json(200, await (isDistribution ? distribution(site, item, article) : report(site, item, article, Number(days))));
  } catch (error) {
    if (error instanceof ReplyActionError) return json(error.status, { message: error.message });
    console.error("Article insights request failed", error instanceof Error ? error.name : "UnknownError");
    const message = method === "POST"
      ? "Couldn't confirm the reply action. Retry to check the same submission."
      : "Could not load analytics. Try again shortly.";
    return json(500, { message });
  }
}
