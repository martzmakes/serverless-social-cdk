import { expect, it, vi } from "vitest";
import { processRetryMessage } from "../lib/lambdas/ap/retry";
import { processOne, type DeliverDeps, type DeliverEvent } from "../lib/lambdas/ap/deliver";
import { articleFromIndexRow } from "../lib/lambdas/pds/longform-index";
import { outboxIndexFromItems } from "../lib/lambdas/ap-deps";
import { processEvent, refreshManagedDiscussion, type Ports } from "../lib/lambdas/pds/longform-renderer";
import { eventsFromStream, managedBlueskyEventsFromStream } from "../lib/lambdas/pds/longform-renderer-aws";
import { renderArticleHtml } from "../lib/lambdas/pds/longform-render";
import { fitsLaunchLimit } from "../launches";

const origin = "https://writer.example.com";
const handle = "writer.example.com";
const did = "did:plc:writer";
const rkey = "3marticle12345";
const date = "2026-10-01T12:00:00.000Z";
const record = { title: "The article", slug: "article", content: "Public article text.", createdAt: date, managedLaunch: true };
const item = {
  rkey, currentSlug: "article", title: record.title, excerpt: "", status: "published" as const, cid: "article-cid",
  createdAt: date, publishedAt: date, tags: [], priorSlugs: [], managedLaunch: true, syndication: {},
};

it("holds the automatically generated Bluesky link while rendering the managed article as public", async () => {
  const putIndex = vi.fn(async () => {});
  const putObject = vi.fn(async () => {});
  const syndicate = vi.fn(async () => ({ uri: "", cid: "" }));
  const ports: Ports = {
    getIndex: async () => undefined, listIndex: async () => [],
    getRecord: async () => record, putObject, putIndex,
    deleteObject: async () => {}, ownerOf: async () => undefined,
    kvsPut: async () => {}, kvsDel: async () => {},
    syndicate, deleteSyndication: async () => {},
  };
  await processEvent({ rkey, op: "upsert", cid: item.cid, did }, ports, { origin, siteName: "Writer", author: handle });
  expect(syndicate).not.toHaveBeenCalled();
  expect(putIndex).toHaveBeenCalledWith(expect.objectContaining({ managedLaunch: true }), expect.anything());
  expect(putObject).toHaveBeenCalledWith("article/index.html", expect.stringContaining(`<link rel="canonical" href="${origin}/article">`), "text/html; charset=utf-8");
});

it("delivers the controlled AP announcement once and leaves unlaunched articles off the outbox", async () => {
  const announcement = { text: "A launch <from> Me\nOn ActivityPub", publishedAt: "2026-11-19T12:00:00.000Z" };
  const key = "3mbluesky12345";
  const syndication = { uri: `at://${did}/app.bsky.feed.post/${key}`, cid: "bsky-cid" };
  const read = articleFromIndexRow({ item, launchActivityPub: announcement, launchBluesky: syndication })!;
  expect(read.syndication.bsky).toEqual(syndication);
  expect(outboxIndexFromItems([item]).slugByRkey.has(rkey)).toBe(false);
  const outbox = outboxIndexFromItems([read]);
  expect(outbox.slugByRkey.get(rkey)).toBe("article");
  expect(outbox.announcementByRkey?.get(rkey)).toEqual(announcement);
  expect(outbox.suppressedPostRkeys.has(key)).toBe(true);

  const done = new Set<string>();
  const postFetch = vi.fn<DeliverDeps["postFetch"]>(async () => ({ status: 202 }));
  const deps: DeliverDeps = {
    resolveHandle: async () => ({ handle }),
    loadPostRecord: async () => null,
    loadLongform: async () => record,
    getLongformIndex: async () => ({
      slug: item.currentSlug, cid: item.cid, status: item.status, managedLaunch: true, announcement,
    }),
    isSyndicationLink: async () => false,
    followers: {
      list: async () => [{ actorId: "https://remote.example/users/reader", inbox: "https://remote.example/inbox" }],
      remove: async () => {},
    },
    ledger: {
      claim: async key => !done.has(key),
      complete: async key => { done.add(key); },
      release: async () => {},
    },
    retryQueue: { enqueue: async () => {} },
    getApKey: async () => ({ privatePem: "fixture" }),
    signRequest: async () => ({}),
    postFetch,
    customHosts: [handle],
  };
  const event: DeliverEvent = { did, rkey, collection: "social.serverless.longform", op: "create", cid: item.cid };
  await processOne(event, deps, "stream");
  await processOne({ ...event, op: "update" }, deps, "stream");
  expect(postFetch).not.toHaveBeenCalled();

  const queued = { kind: "event" as const, event: { ...event, launch: true as const } };
  await processRetryMessage(queued, deps);
  await processRetryMessage(queued, deps);
  expect(postFetch).toHaveBeenCalledTimes(1);
  const activity = JSON.parse(postFetch.mock.calls[0][1].body.toString("utf8"));
  expect(activity.object).toMatchObject({
    id: `${origin}/ap/users/${handle}/articles/${rkey}`,
    type: "Article", published: announcement.publishedAt, summary: "A launch &lt;from&gt; Me\nOn ActivityPub",
    url: origin + "/article",
  });
  expect(activity.object.content).toContain("A launch &lt;from&gt; Me<br>On ActivityPub");
  expect(activity.object.content).toContain(origin + "/article?utm_source=fediverse");
});

it("validates both graphemes and the Bluesky record byte budget", () => {
  expect(fitsLaunchLimit("Thin fonts 👩🏽‍🎨", origin + "/article", "bluesky")).toBe(true);
  expect(fitsLaunchLimit("a".repeat(300), origin + "/article", "bluesky")).toBe(false);
  expect(fitsLaunchLimit("a" + "\u0301".repeat(1800), origin + "/article", "bluesky")).toBe(false);
});

it("only routes new managed Bluesky index associations to the targeted HTML updater", () => {
  const published = { uri: { S: `at://${did}/app.bsky.feed.post/3mbluesky12345` }, cid: { S: "bsky-cid" } };
  const Keys = { pk: { S: `IDX#${did}` }, sk: { S: rkey } };
  const managed = { eventName: "MODIFY", dynamodb: { Keys, NewImage: { launchBluesky: { M: published } }, OldImage: {} } };
  const legacy = { eventName: "MODIFY", dynamodb: { Keys, NewImage: { item: {} }, OldImage: {} } };
  const edited = { ...managed, dynamodb: { ...managed.dynamodb, OldImage: managed.dynamodb.NewImage } };
  const stream = { Records: [legacy, managed, edited] };
  expect(managedBlueskyEventsFromStream(stream)).toEqual([{
    did, rkey, syndication: { uri: published.uri.S, cid: published.cid.S },
  }]);
  expect(eventsFromStream(stream)).toEqual([]);
});

it("patches the canonical article comments and metadata once with the object's current ETag", async () => {
  const syndication = { uri: `at://${did}/app.bsky.feed.post/3mbluesky12345`, cid: "bsky-cid" };
  const event = { did, rkey, syndication };
  const context = { origin, siteName: "Writer", author: handle };
  const scope = { did, isApex: false, s3Prefix: `t/${handle}/` };
  const section = renderArticleHtml(record, context);
  const fresh = renderArticleHtml({ ...record, authorHandle: handle, syndication: { bsky: syndication } }, context);
  let html = section;
  const index = vi.fn(async () => ({ ...item, syndication: { bsky: syndication } }));
  const readArticle = vi.fn(async () => ({ html, etag: "version-1" }));
  const updateArticle = vi.fn(async (_: string, output: string, _etag: string) => { html = output; });
  const ports = { getIndex: index, readArticle, updateArticle };

  await refreshManagedDiscussion(event, ports, context, scope);
  expect(html).toEqual(fresh);
  expect(html).toContain(`data-thread-uri="${syndication.uri}"`);
  expect(html).toContain("syndicated to bluesky");
  expect(html).toContain("Public article text.");
  expect(updateArticle).toHaveBeenCalledExactlyOnceWith(`t/${handle}/article/index.html`, fresh, "version-1");

  await refreshManagedDiscussion(event, ports, context, scope);
  expect(updateArticle).toHaveBeenCalledTimes(1);

  await refreshManagedDiscussion({ ...event, syndication: { ...syndication, cid: "stale" } }, ports, context, scope);
  expect(readArticle).toHaveBeenCalledTimes(2);
  expect(updateArticle).toHaveBeenCalledTimes(1);
});
