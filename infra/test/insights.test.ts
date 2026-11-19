import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const db = vi.hoisted(() => {
  process.env.DOMAIN = "social.example.com";
  process.env.PDS_HANDLE = "author.example.com";
  process.env.KNOWN_TENANT_HOSTS = "writer.example.net,other.example.net";
  process.env.LONGFORM_INDEX_TABLE = "index";
  process.env.POST_ANALYTICS_TABLE = "reports";
  process.env.SITE_BUCKET = "pages";
  process.env.AP_INBOUND_TABLE = "ap-inbound";
  process.env.AP_CUSTOM_HOSTS = "writer.example.net";
  return { send: vi.fn(), readPage: vi.fn() };
});
vi.mock("../lib/lambdas/auth/lib/jwt", () => ({
  verifyJwt: async (token: string) => {
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
  DynamoDBDocumentClient: { from: () => db },
}));

import { handler } from "../lib/lambdas/analytics/insights";
import { parseCloudFrontLog } from "../lib/lambdas/analytics/log-parse";
import { taggedArticleUrl } from "../insights";

const article = {
  rkey: "post1",
  title: "An article",
  status: "published",
  currentSlug: "an-article",
  publishedAt: "2026-11-16T12:00:00Z",
  syndication: { bsky: { uri: "at://did:plc:writer/app.bsky.feed.post/thread1" } },
};

function event(path: string, query?: Record<string, string>, rkey?: string, authorization = "Bearer valid") {
  return {
    rawPath: `/auth/insights${path}`,
    headers: { authorization },
    queryStringParameters: query,
    pathParameters: rkey ? { rkey } : undefined,
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
    db.send.mockReset();
    db.readPage.mockReset();
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
    }] });
    const response = await handler(event("/articles/post1/replies", { did: "did:plc:writer" }, "post1"));
    expect(response.statusCode).toBe(200);
    expect(db.send.mock.calls[1][0].input).toMatchObject({
      TableName: "ap-inbound", IndexName: "byPublished",
      ExpressionAttributeValues: { ":pk": "writer.example.net#article-replies", ":first": "post1#" },
    });
    expect(JSON.parse(response.body)).toMatchObject({ replies: [
      { network: "Bluesky", text: "A Bluesky reply" }, { network: "Fediverse", text: "Fediverse & Bluesky" },
    ], unavailable: [] });
  });

  it("does not read traffic for a deleted article", async () => {
    db.send.mockResolvedValueOnce({ Item: { item: { ...article, status: "deleted" } } });
    const result = await handler(event("/articles/post1", { did: "did:plc:writer" }, "post1"));
    expect(result.statusCode).toBe(404);
    expect(db.send).toHaveBeenCalledTimes(1);
  });
});
