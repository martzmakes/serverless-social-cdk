import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const db = vi.hoisted(() => {
  process.env.DOMAIN = "social.example.com";
  process.env.PDS_HANDLE = "author.example.com";
  process.env.KNOWN_TENANT_HOSTS = "writer.example.net,other.example.net";
  process.env.LONGFORM_INDEX_TABLE = "index";
  process.env.POST_ANALYTICS_TABLE = "reports";
  process.env.SITE_SHARING_TABLE = "sharing";
  process.env.SITE_BUCKET = "pages";
  process.env.AP_INBOUND_TABLE = "ap-inbound";
  process.env.REPLY_API_ORIGIN = "https://api.example.net";
  process.env.AP_CUSTOM_HOSTS = "writer.example.net";
  return { send: vi.fn(), policies: new Map<string, object>(), readPage: vi.fn(), mint: vi.fn() };
});
vi.mock("../lib/lambdas/auth/session-mint", () => ({ mintFirstPartySessionFor: db.mint }));
vi.mock("../lib/lambdas/auth/lib/jwt", () => ({
  loadAppJwtKey: async () => new Uint8Array([1, 2, 3]),
  verifyJwt: async (token: string) => {
    if (token === "writer-site") return { email: "owner@example.net", siteHost: "writer.example.net" };
    if (token === "apex-site") return { email: "owner@example.net", siteHost: "social.example.com" };
    if (token !== "valid") throw new Error("Invalid token");
    return { email: "owner@example.net" };
  },
}));
vi.mock("../lib/lambdas/auth/entitlements", () => ({
  resolveApprovedDids: async () => [
    { did: "did:web:author.example.com", handle: "author.example.com" },
    { did: "did:plc:writer", handle: "writer.example.net" },
    { did: "did:plc:unhosted", handle: "unhosted.example.net" },
  ],
}));
vi.mock("@aws-sdk/client-s3", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/client-s3")>(),
  S3Client: class { send = db.readPage; },
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({
    send(command: { input: { TableName?: string; Key?: { pk: string; sk: string }; Item?: { pk: string; sk: string } } }) {
      const { TableName, Key, Item } = command.input;
      if (TableName !== "sharing") return db.send(command);
      if (Item) {
        db.policies.set(`${Item.pk}/${Item.sk}`, Item);
        return {};
      }
      return { Item: db.policies.get(`${Key!.pk}/${Key!.sk}`) };
    },
  }) },
}));

import { handler } from "../lib/lambdas/analytics/insights";
import { parseCloudFrontLog } from "../lib/lambdas/analytics/log-parse";
import { taggedArticleUrl } from "../insights";

const rootCid = "bafy" + "a".repeat(54);
const remoteCid = "bafy" + "b".repeat(54);
const remoteBskyUri = "at://did:plc:subscriber/app.bsky.feed.post/reply1";
const remoteApUri = "https://mastodon.example/@qa/1";
const ownerDid = "did:plc:writer";
const requestId = "d79baf35-8709-4c9c-92f9-85b561438fdc";
const article = {
  rkey: "post1",
  title: "An article",
  status: "published",
  currentSlug: "an-article",
  publishedAt: "2026-11-16T12:00:00Z",
  syndication: { bsky: { uri: "at://did:plc:writer/app.bsky.feed.post/thread1", cid: rootCid } },
};

function event(path: string, query?: Record<string, string>, rkey?: string, authorization = "Bearer valid") {
  return {
    rawPath: `/auth/insights${path}`,
    headers: { authorization },
    queryStringParameters: query,
    pathParameters: rkey ? { rkey } : undefined,
  } as unknown as APIGatewayProxyEventV2;
}

function replyAction(body: object, did = ownerDid, rkey = article.rkey) {
  return {
    ...event(`/articles/${rkey}/replies`, { did }, rkey),
    requestContext: { http: { method: "POST" } }, body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

describe("CloudFront article attribution", () => {
  it("persists allowlisted UTM labels ahead of referrers, even when the query is encoded", () => {
    const headers = "#Fields: cs(User-Agent) date cs-method cs-uri-stem sc-status sc-content-type x-host-header cs-uri-query cs(Referer)";
    function row(agent: string, query: string, referrer: string, path = "/an-article") {
      return [encodeURIComponent(agent), "2026-11-19", "GET", path, "200", "text/html", "writer.example.net", query, referrer].join("\t");
    }
    const log = Buffer.from([
      headers,
      row("Mozilla/5.0 (iPhone) Mobile", "utm_source=Instagram&token=private", "https://www.linkedin.com/path"),
      row("Mozilla/5.0 (Windows NT 10.0)", "utm_source%3Dlinkedin%26secret%3Dcustomer", "-"),
      row("Mozilla/5.0 (Android 14)", "utm_source=unexpected", "https%3A%2F%2Fl.instagram.com%2Fpath"),
      row("Mozilla/5.0 (Macintosh) Mobile/15E148", "-", "https://writer.example.net/another"),
      row("SomeClient/1.0", "-", "http://192.0.2.1/private"),
      row("facebookexternalhit/1.1", "utm_source=facebook", "-"),
      row("Mozilla/5.0", "-", "-", "/compose"),
    ].join("\n"));
    const result = parseCloudFrontLog(log);
    expect(result.map(({ source, device, referrerHost, uaClass }) => [source, device, referrerHost, uaClass])).toEqual([
      ["instagram", "mobile", "linkedin.com", "human"],
      ["linkedin", "desktop", "direct", "human"],
      ["instagram", "tablet", "instagram.com", "human"],
      ["internal", "tablet", "example.net", "human"],
      ["direct", "unknown", "direct", "human"],
      ["facebook", "unknown", "direct", "bot"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|token|customer|Mozilla|192\.0\.2\.1/);
  });

  it("retains canonical parameters when generating a tagged link", () => {
    const link = new URL(taggedArticleUrl("https://example.net/article?lang=en", "linkedin"));
    expect(link.searchParams.get("lang")).toBe("en");
    expect(link.searchParams.get("utm_source")).toBe("linkedin");
  });
});

describe("author insights", () => {
  beforeEach(() => {
    db.policies.clear();
    db.send.mockReset();
    db.readPage.mockReset();
    db.mint.mockReset();
    db.mint.mockImplementation(async (_email, did) => ({ did, accessJwt: `fixture-for:${did}` }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("requires a session and rejects other tenants before touching the index or rollups", async () => {
    expect((await handler(event("", undefined, undefined, "invalid"))).statusCode).toBe(401);
    expect((await handler(event("/articles/post1", { did: "did:plc:other", host: "other.example.net" }, "post1"))).statusCode).toBe(403);
    expect(db.send).not.toHaveBeenCalled();
    const result = await handler(event(""));
    expect(JSON.parse(result.body).sites).toEqual([
      { did: "did:web:author.example.com", handle: "author.example.com", host: "social.example.com" },
      { did: "did:plc:writer", handle: "writer.example.net", host: "writer.example.net" },
    ]);
    expect(result.headers["cache-control"]).toBe("private, no-store");
  });

  it("paginates the approved tenant's index without exposing deleted articles", async () => {
    db.send.mockResolvedValueOnce({ Items: [{ item: article }, { item: { ...article, status: "deleted" } }],
      LastEvaluatedKey: { pk: "IDX#did:plc:writer", sk: "next" } });
    const result = await handler(event("/articles", { did: "did:plc:writer", after: "cursor" }));
    expect(db.send.mock.calls[0][0].input).toMatchObject({
      TableName: "index",
      ExclusiveStartKey: { pk: "IDX#did:plc:writer", sk: "cursor" },
    });
    expect(JSON.parse(result.body)).toMatchObject({
      articles: [{ rkey: "post1", url: "https://writer.example.net/an-article", blueskyUrl: expect.stringContaining("bsky.app/") }],
      next: "next",
    });
    expect(JSON.parse(result.body).articles).toHaveLength(1);
  });

  it("lets each host veto sharing in one direction and rejects settings writes from the other site's session", async () => {
    const host = "writer.example.net";
    const apex = "social.example.com";
    const fromHost = (value: APIGatewayProxyEventV2, viewer: string) => ({
      ...value, headers: { ...value.headers, "x-pds-viewer-host": viewer },
    });
    const settings = {
      ...fromHost(event("/sharing", undefined, undefined, "Bearer writer-site"), host),
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({ peer: apex, outgoing: false, incoming: true }),
    } as unknown as APIGatewayProxyEventV2;
    expect((await handler(fromHost(settings, apex))).statusCode).toBe(403);
    expect((await handler(settings)).statusCode).toBe(200);
    const apexCatalog = await handler(event("", undefined, undefined, "Bearer apex-site"));
    expect(JSON.parse(apexCatalog.body).sites.map((site: { host: string }) => site.host)).toEqual([apex]);
    const writerCatalog = await handler(fromHost(event("", undefined, undefined, "Bearer writer-site"), host));
    expect(JSON.parse(writerCatalog.body).sites.map((site: { host: string }) => site.host)).toEqual([apex, host]);
    const forbidden = await handler(event("/replies", { did: ownerDid }, undefined, "Bearer apex-site"));
    expect(forbidden.statusCode).toBe(403);
    expect(db.send).not.toHaveBeenCalled();
  });

  it("bounds and authorizes the queue and keeps the site, article, and handled state attached to each reply", async () => {
    expect((await handler(event("/replies", { did: ownerDid }, undefined, "invalid"))).statusCode).toBe(401);
    expect((await handler(event("/replies", { did: "did:plc:unhosted" }))).statusCode).toBe(403);
    expect((await handler(event("/replies", { did: ownerDid, after: "other/site" }))).statusCode).toBe(400);
    expect(db.send).not.toHaveBeenCalled();
    const later = { ...article, rkey: "post2", currentSlug: "another-article", syndication: {} };
    db.send.mockImplementation(async ({ input }) => {
      if (input.TableName === "index") return {
        Items: [{ item: article }, { item: later }, { item: { ...later, rkey: "deleted", status: "deleted" } }],
        LastEvaluatedKey: { pk: `IDX#${ownerDid}`, sk: "next" },
      };
      if (input.TableName === "ap-inbound") {
        if (input.ExpressionAttributeValues[":first"] === "post2#") return { Items: [] };
        return { Items: [{ sortKey: "post1#2026-11-19T11:00:00.000Z#ad6abcdef1234567", ttl: 1_900_000_000, item: {
          id: remoteApUri, url: remoteApUri, published: "2026-11-19T11:00:00Z",
          actor: { handle: "mastodon.example" }, content: "<p>hello</p>",
        } }] };
      }
      return { Responses: { reports: input.RequestItems.reports.Keys } };
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const response = await handler(event("/replies", { did: ownerDid, after: "cursor" }));
    expect(response.statusCode).toBe(200);
    expect(db.send.mock.calls[0][0].input).toMatchObject({
      TableName: "index", Limit: 8, ExclusiveStartKey: { pk: `IDX#${ownerDid}`, sk: "cursor" },
    });
    expect(JSON.parse(response.body)).toMatchObject({ next: "next", threads: [{
      article: { rkey: "post1", url: "https://writer.example.net/an-article" },
      replies: [{ id: remoteApUri, handled: true, text: "hello" }], unavailable: ["Bluesky"],
    }] });
    expect(JSON.parse(response.body).threads).toHaveLength(1);
    expect(db.send.mock.calls.filter(([command]) => command.input.TableName === "ap-inbound")).toHaveLength(2);
  });

  it("retains legacy daily totals and domains while reporting coverage of new buckets, scoped to one host", async () => {
    const refCursor = { pk: "VIEW#writer.example.net#an-article", sk: "REF#2026-11-17#linkedin.com" };
    db.send
      .mockResolvedValueOnce({ Item: { item: article } })
      .mockResolvedValueOnce({ Items: [
        { sk: "2026-11-17", views: 10, uaBot: 4 },
        { sk: "2026-11-18", views: 5, uaBot: 2, classifiedViews: 5, source_linkedin: 3, source_direct: 2,
          device_desktop: 2, device_mobile: 3, source_fake: 8 },
      ] })
      .mockResolvedValueOnce({ Items: [{ sk: refCursor.sk, count: 5 }], LastEvaluatedKey: refCursor })
      .mockResolvedValueOnce({ Items: [{ sk: "REF#2026-11-18#linkedin.com", count: 3 }, { sk: "REF#2026-11-18#192.0.2.1", count: 4 }] });
    const result = await handler(event("/articles/post1", { did: "did:plc:writer", days: "7", host: "other.example.net" }, "post1"));
    expect(result.statusCode).toBe(200);
    expect(db.send.mock.calls[0][0].input.Key).toEqual({ pk: "IDX#did:plc:writer", sk: "post1" });
    expect(db.send.mock.calls.slice(1).map(([command]) => command.input.ExpressionAttributeValues[":pk"])).toEqual(Array(3).fill(refCursor.pk));
    expect(db.send.mock.calls[1][0].input.ExpressionAttributeValues[":start"]).toBe("2026-11-16");
    expect(db.send.mock.calls[3][0].input.ExclusiveStartKey).toEqual(refCursor);
    expect(JSON.parse(result.body)).toMatchObject({
      views: 15, classifiedViews: 5, sources: { linkedin: 3, direct: 2 }, devices: { desktop: 2, mobile: 3 },
      referrers: [{ host: "linkedin.com", views: 8 }],
    });
    expect(JSON.parse(result.body).daily).toHaveLength(7);
    expect(result.body).not.toMatch(/source_fake|192\.0\.2\.1/);
  });

  it("reads the exact hosted article card and its latest Bluesky snapshot", async () => {
    db.send.mockResolvedValueOnce({ Item: { item: article } })
      .mockResolvedValueOnce({ Items: [{ sk: "2026-11-19", likes: 8, reposts: 2, replies: 3 }] });
    db.readPage.mockResolvedValueOnce({ Body: { transformToString: async () =>
      '<head><meta property="og:title" content="An article &amp; a cover">' +
      '<meta property="og:image" content="https://writer.example.net/cover.jpg">' +
      '<meta property="og:image:alt" content="An image"></head><body>body</body>' } });
    const response = await handler(event("/articles/post1/distribution", { did: "did:plc:writer" }, "post1"));
    expect(response.statusCode).toBe(200);
    expect(db.readPage.mock.calls[0][0].input).toEqual({ Bucket: "pages", Key: "t/writer.example.net/an-article/index.html", Range: "bytes=0-65535" });
    expect(db.send.mock.calls[1][0].input).toMatchObject({
      ExpressionAttributeValues: { ":pk": "ENGAGE#at://did:plc:writer/app.bsky.feed.post/thread1" },
      Limit: 1, ScanIndexForward: false,
    });
    expect(JSON.parse(response.body)).toEqual({
      activityPubUrl: "https://writer.example.net/ap/users/writer.example.net/articles/post1",
      bluesky: { day: "2026-11-19", likes: 8, reposts: 2, replies: 3 },
      socialCard: { title: "An article & a cover", image: "https://writer.example.net/cover.jpg", imageAlt: "An image" },
    });
  });

  it("sorts replies from both networks and keeps Fediverse reads inside one article partition", async () => {
    const fetchThread = vi.fn(async () => Response.json({ thread: { replies: [{ post: {
      uri: "at://did:plc:other/app.bsky.feed.post/reply1",
      author: { handle: "blue.example.com" }, record: { text: "A Bluesky reply", createdAt: "2026-11-19T11:30:00Z" },
    } }] } }));
    vi.stubGlobal("fetch", fetchThread);
    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({ Items: [{
      sortKey: "post1#2026-11-19T11:00:00.000Z#ad6abcdef1234567", ttl: 1_900_000_000,
      item: { id: "https://mastodon.example/@qa/1", url: "https://mastodon.example/@qa/1", published: "2026-11-19T11:00:00Z",
        actor: { handle: "mastodon.example" }, content: "<p>Fediverse &amp; Bluesky</p>" },
    }] }).mockImplementationOnce(async command => {
      const keys = command.input.RequestItems.reports.Keys;
      expect(keys).toHaveLength(2);
      expect(keys.every((key: { pk: string; sk: string }) => key.pk === `REPLY_STATE#${ownerDid}` && key.sk.startsWith("post1#"))).toBe(true);
      return { Responses: { reports: [keys[1]] } };
    });
    const response = await handler(event("/articles/post1/replies", { did: "did:plc:writer" }, "post1"));
    expect(response.statusCode).toBe(200);
    expect(db.send.mock.calls[1][0].input).toMatchObject({
      TableName: "ap-inbound", IndexName: "byPublished",
      ExpressionAttributeValues: { ":pk": "writer.example.net#article-replies", ":first": "post1#" },
    });
    expect(JSON.parse(response.body)).toMatchObject({ replies: [
      { network: "Bluesky", text: "A Bluesky reply", handled: false }, { network: "Fediverse", text: "Fediverse & Bluesky", handled: true },
    ], unavailable: [] });
  });

  it("keeps handled status private and scoped to a visible reply, and allows reopening", async () => {
    const parent = {
      sortKey: "post1#2026-11-19T11:00:00.000Z#ad6abcdef1234567", ttl: 1_900_000_000,
      owner: "https://mastodon.example/users/qa",
      item: { id: remoteApUri, actor: { id: "https://mastodon.example/users/qa" } },
    };
    const action = { action: "handled", network: "Fediverse", id: remoteApUri, handled: true };
    expect((await handler(replyAction(action, "did:plc:other"))).statusCode).toBe(403);
    expect(db.send).not.toHaveBeenCalled();
    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({ Item: { ...parent, sortKey: "other#timestamp" } });
    expect((await handler(replyAction(action))).statusCode).toBe(422);
    expect(db.send).toHaveBeenCalledTimes(2);

    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({ Item: parent }).mockResolvedValueOnce({});
    expect(JSON.parse((await handler(replyAction(action))).body)).toEqual({ handled: true });
    const handled = db.send.mock.calls[4][0].input.Item;
    expect(handled).toEqual({ pk: `REPLY_STATE#${ownerDid}`, sk: expect.stringMatching(/^post1#[0-9a-f]{64}$/) });
    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({ Item: parent }).mockResolvedValueOnce({});
    expect(JSON.parse((await handler(replyAction({ ...action, handled: false }))).body)).toEqual({ handled: false });
    expect(db.send.mock.calls[7][0].input.Key).toEqual(handled);
    expect(db.mint).not.toHaveBeenCalled();
  });

  it("writes a real AT reply from the selected DID and recovers an ambiguous response with the same key", async () => {
    let record: { rkey: string; record: object } | undefined;
    const root = article.syndication.bsky;
    const fetchNetwork = vi.fn(async (target: URL, init?: RequestInit) => {
      if (target.hostname === "public.api.bsky.app") {
        expect(target.pathname).toBe("/xrpc/app.bsky.feed.getPosts");
        expect(target.searchParams.get("uris")).toBe(remoteBskyUri);
        return Response.json({ posts: [{ uri: remoteBskyUri, cid: remoteCid, record: { reply: { root } } }] });
      }
      expect(target.hostname).toBe("api.example.net");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer fixture-for:${ownerDid}`);
      if (target.pathname.endsWith("putRecord")) {
        record = JSON.parse(String(init?.body));
        expect(record).toMatchObject({
          repo: ownerDid, collection: "app.bsky.feed.post", swapRecord: null,
          record: { text: "Thanks for reading", reply: { root, parent: { uri: remoteBskyUri, cid: remoteCid } } },
        });
        expect(db.send.mock.calls.at(-1)?.[0].input.Item).toMatchObject({ pk: `bluesky-only#${ownerDid}`, sk: record!.rkey });
        return new Response("connection interrupted", { status: 502 });
      }
      expect(target.searchParams.get("rkey")).toBe(record?.rkey);
      return Response.json({ uri: `at://${ownerDid}/app.bsky.feed.post/${record!.rkey}`, value: record!.record });
    });
    vi.stubGlobal("fetch", fetchNetwork);
    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const input = { action: "send", network: "Bluesky", id: remoteBskyUri, text: "Thanks for reading", requestId };
    const response = await handler(replyAction(input));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: "sent", url: expect.stringMatching(/^https:\/\/bsky\.app/) });
    expect(db.mint).toHaveBeenCalledWith("owner@example.net", ownerDid, expect.anything());
    const savedIntent = db.send.mock.calls[2][0].input.Item;
    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({ Item: savedIntent }).mockResolvedValueOnce({});
    const retried = await handler(replyAction(input));
    expect(JSON.parse(retried.body)).toEqual(JSON.parse(response.body));
    expect(fetchNetwork.mock.calls.filter(([url]) => url.hostname === "public.api.bsky.app")).toHaveLength(1);

    db.send.mockResolvedValueOnce({ Item: { item: article } }).mockResolvedValueOnce({ Item: savedIntent });
    expect((await handler(replyAction({ ...input, text: "Different" }))).statusCode).toBe(409);
  });

  it("sends Fediverse replies through the owner-scoped AP route and preserves the queued outcome", async () => {
    db.send.mockResolvedValueOnce({ Item: { item: article } });
    const fetchNetwork = vi.fn(async (url: URL, req: RequestInit) => {
      expect(url.href).toBe("https://api.example.net/ap/users/writer.example.net/replies");
      expect(new Headers(req.headers).get("Authorization")).toBe(`Bearer fixture-for:${ownerDid}`);
      expect(JSON.parse(String(req.body))).toEqual({ articleRkey: article.rkey, parentId: remoteApUri, text: "Appreciate it", requestId });
      return Response.json({ status: "queued", url: `https://writer.example.net/ap/users/writer.example.net/replies/${requestId}` }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchNetwork);
    const result = await handler(replyAction({ action: "send", network: "Fediverse", id: remoteApUri, text: "Appreciate it", requestId }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: "queued" });
    expect(fetchNetwork).toHaveBeenCalledTimes(1);
  });

  it("does not read traffic for a deleted article", async () => {
    db.send.mockResolvedValueOnce({ Item: { item: { ...article, status: "deleted" } } });
    const result = await handler(event("/articles/post1", { did: "did:plc:writer" }, "post1"));
    expect(result.statusCode).toBe(404);
    expect(db.send).toHaveBeenCalledTimes(1);
  });
});
