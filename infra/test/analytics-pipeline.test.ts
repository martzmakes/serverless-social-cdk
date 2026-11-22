import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/lambdas/auth/session-mint", () => ({ mintFirstPartySessionFor: vi.fn() }));
vi.mock("../lib/lambdas/auth/lib/jwt", () => ({ loadAppJwtKey: async () => new Uint8Array([1]), verifyJwt: vi.fn() }));

import { addressFilter, pageOf, parseCloudFrontLog, uaClass } from "../lib/lambdas/analytics/log-parse";
import { addExpression, rollupEvents } from "../lib/lambdas/analytics/rollup";
import { aggregateLogObject } from "../lib/lambdas/analytics/aggregate";
import { edgeLocation } from "../lib/lambdas/analytics/edge-locations";
import { buildSiteOverview, snapshotChange } from "../lib/lambdas/analytics/site-overview";

const FIELDS = ["date", "time", "x-edge-location", "sc-bytes", "c-ip", "cs-method", "cs(Host)", "cs-uri-stem", "sc-status",
  "cs(Referer)", "cs(User-Agent)", "cs-uri-query", "cs(Cookie)", "x-edge-result-type", "x-edge-request-id", "x-host-header",
  "cs-protocol", "cs-bytes", "time-taken", "x-forwarded-for", "ssl-protocol", "ssl-cipher", "x-edge-response-result-type",
  "cs-protocol-version", "fle-status", "fle-encrypted-fields", "c-port", "time-to-first-byte", "x-edge-detailed-result-type",
  "sc-content-type", "sc-content-len", "sc-range-start", "sc-range-end"];
const CHROME = "Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X%2010_15_7)%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko)%20Chrome/150.0.0.0%20Safari/537.36";
const IPHONE = "Mozilla/5.0%20(iPhone;%20CPU%20iPhone%20OS%2018_7%20like%20Mac%20OS%20X)%20AppleWebKit/605.1.15%20(KHTML,%20like%20Gecko)%20Mobile/15E148";

function row(values: Partial<Record<string, string>>) {
  const base: Record<string, string> = {
    date: "2026-11-20", time: "12:00:00", "x-edge-location": "LHR61-P2", "c-ip": "203.0.113.9", "cs-method": "GET",
    "cs(Host)": "d111.cloudfront.net", "cs-uri-stem": "/my-article", "sc-status": "200", "cs(Referer)": "-",
    "cs(User-Agent)": CHROME, "cs-uri-query": "-", "x-host-header": "example.com", "sc-content-type": "text/html",
  };
  const merged = { ...base, ...values };
  return FIELDS.map(name => merged[name] ?? "-").join("\t");
}
const log = (...rows: string[]) => Buffer.from(`#Version: 1.0\n#Fields: ${FIELDS.join(" ")}\n${rows.join("\n")}\n`);

describe("user agent classification", () => {
  it("counts browsers and rejects scripts, previewers and agents", () => {
    expect(uaClass(CHROME)).toBe("human");
    expect(uaClass(IPHONE)).toBe("human");
    expect(uaClass("node")).toBe("bot");
    expect(uaClass("ActionExtension/2%20CFNetwork/3896.200.61%20Darwin/27.2.0")).toBe("bot");
    expect(uaClass("KiroServer/1.0")).toBe("bot");
    expect(uaClass("Mozilla/5.0%20AppleWebKit/537.36%20(KHTML,%20like%20Gecko;%20compatible;%20ChatGPT-User/1.0)")).toBe("bot");
    expect(uaClass("Mozilla/5.0%20(compatible;%20Discordbot/2.0)")).toBe("bot");
    expect(uaClass("-")).toBe("bot");
  });
});

describe("page paths", () => {
  it("maps the home page, articles and short posts", () => {
    expect(pageOf("/")).toEqual({ kind: "home", slug: "" });
    expect(pageOf("/my-article/")).toEqual({ kind: "article", slug: "my-article" });
    expect(pageOf("/profile/Example.com/post/3lnogkww3p222")).toEqual({ kind: "post", slug: "3lnogkww3p222", actor: "example.com" });
    expect(pageOf("/profile/example.com")).toBeUndefined();
    expect(pageOf("/a/b")).toBeUndefined();
    expect(pageOf("/favicon.ico")).toBeUndefined();
  });
});

describe("edge locations", () => {
  it("reads the metro code and its country", () => {
    expect(edgeLocation("IAD89-P1")).toEqual({ edge: "IAD", country: "US" });
    expect(edgeLocation("GRU3-C1")).toEqual({ edge: "GRU", country: "BR" });
    expect(edgeLocation("QQQ1-P1")).toEqual({ edge: "QQQ", country: "ZZ" });
    expect(edgeLocation("-")).toBeUndefined();
  });
});

describe("address exclusion", () => {
  it("matches IPv4 and IPv6 networks and ignores bad entries", () => {
    const excluded = addressFilter(["198.51.100.0/24", "2001:db8::/32", "not-an-ip", "10.0.0.1/99"]);
    expect(excluded("198.51.100.77")).toBe(true);
    expect(excluded("198.51.101.1")).toBe(false);
    expect(excluded("2001:db8:1::5")).toBe(true);
    expect(excluded("10.0.0.1")).toBe(false);
    expect(excluded(undefined)).toBe(false);
    expect(addressFilter([])("198.51.100.77")).toBe(false);
  });
});

describe("log parsing and rollup", () => {
  const buf = log(
    row({}),
    row({ "x-edge-location": "LHR50-C1", "cs(Referer)": "https://www.linkedin.com/feed/" }),
    row({ "cs(User-Agent)": "node" }),
    row({ "cs-uri-stem": "/", "x-edge-location": "GRU3-C1", "cs(User-Agent)": IPHONE }),
    row({ "cs-uri-stem": "/profile/example.com/post/3abc", "x-edge-location": "SIN2-P1" }),
    row({ "c-ip": "198.51.100.7" }),
    row({ "sc-status": "304" }),
    row({ "cs-uri-stem": "/app.js", "sc-content-type": "application/javascript" }),
  );

  it("emits typed, located events and drops excluded networks", () => {
    const events = parseCloudFrontLog(buf, { excludeCidrs: ["198.51.100.0/24"] });
    expect(events.map(e => [e.kind, e.uaClass, e.country, e.edge])).toEqual([
      ["article", "human", "GB", "LHR"],
      ["article", "human", "GB", "LHR"],
      ["article", "bot", "GB", "LHR"],
      ["home", "human", "BR", "GRU"],
      ["post", "human", "SG", "SIN"],
    ]);
    expect(events[1].source).toBe("linkedin");
    expect(JSON.stringify(events)).not.toContain("203.0.113.9");
  });

  it("sums a file into one write per row", () => {
    const rows = rollupEvents(parseCloudFrontLog(buf, { excludeCidrs: ["198.51.100.0/24"] }), "2026-11-21");
    const byKey = Object.fromEntries(rows.map(r => [`${r.key.pk}|${r.key.sk}`, r.counters]));
    expect(byKey["VIEW#example.com#my-article|2026-11-20"]).toEqual({
      views: 2, uaHuman: 2, classifiedViews: 2, source_direct: 1, source_linkedin: 1, device_desktop: 2,
      geo_GB: 2, edge_LHR: 2, uaBot: 1,
    });
    expect(byKey["VIEW#example.com#my-article|REF#2026-11-20#direct"]).toEqual({ count: 1 });
    expect(byKey["VIEW#example.com#my-article|REF#2026-11-20#linkedin.com"]).toEqual({ count: 1 });
    expect(byKey["HOME#example.com|2026-11-20"]).toMatchObject({ views: 1, geo_BR: 1, device_mobile: 1 });
    expect(byKey["POSTVIEW#example.com|2026-11-20#example.com#3abc"]).toMatchObject({ views: 1, geo_SG: 1 });
    expect(Object.keys(byKey).some(k => k.startsWith("POSTVIEW") && k.includes("REF#"))).toBe(false);
    expect(rows).toHaveLength(6);
  });

  it("builds one ADD expression with every counter", () => {
    expect(addExpression({ views: 2, geo_GB: 1 })).toEqual({
      UpdateExpression: "ADD #a0 :a0, #a1 :a1",
      ExpressionAttributeNames: { "#a0": "views", "#a1": "geo_GB" },
      ExpressionAttributeValues: { ":a0": 2, ":a1": 1 },
    });
  });

  it("aggregates a log object idempotently with batched writes", async () => {
    const sent: any[] = [];
    const markers = new Set<string>();
    const doc = {
      send: async (cmd: any) => {
        const input = cmd.input;
        if (input.ConditionExpression) {
          const id = input.Item.pk;
          if (markers.has(id)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
          markers.add(id);
          return {};
        }
        sent.push(input);
        return {};
      },
    };
    const gz = gzipSync(buf);
    expect(await aggregateLogObject("cf/a.gz", gz, doc, "t")).toEqual({ processed: true, views: 6 });
    expect(sent).toHaveLength(6);
    expect(await aggregateLogObject("cf/a.gz", gz, doc, "t")).toEqual({ processed: false, views: 0 });
    expect(sent).toHaveLength(6);
  });
});

describe("snapshot change", () => {
  const rows = [
    { sk: "2026-11-01", followers: 100 }, { sk: "2026-11-10", followers: 110 }, { sk: "2026-11-20", followers: 125 },
  ];
  const metric = (r: Record<string, unknown>) => r.followers as number;
  it("measures from the last snapshot before the window", () => {
    expect(snapshotChange(rows, metric, "2026-11-05", "2026-11-20", false)).toEqual({ latest: 125, change: 25, day: "2026-11-20" });
  });
  it("starts from zero for something new in the window", () => {
    expect(snapshotChange(rows.slice(1), metric, "2026-11-05", "2026-11-20", true)?.change).toBe(125);
  });
  it("falls back to the first snapshot inside the window", () => {
    expect(snapshotChange(rows.slice(1), metric, "2026-11-05", "2026-11-20", false)?.change).toBe(15);
  });
});

describe("site overview", () => {
  const items: Record<string, any>[] = [
    { pk: "IDX#did:plc:me", sk: "a1", item: { rkey: "a1", status: "published", currentSlug: "first-post", title: "First", publishedAt: "2026-10-01T00:00:00Z", syndication: {} } },
    { pk: "IDX#did:plc:me", sk: "a2", item: { rkey: "a2", status: "published", currentSlug: "second-post", title: "Second", publishedAt: "2026-11-15T00:00:00Z", syndication: {} } },
    { pk: "IDX#did:plc:me", sk: "a3", item: { rkey: "a3", status: "draft", currentSlug: "draft", title: "Draft", publishedAt: "", syndication: {} } },
    { pk: "VIEW#me.example#first-post", sk: "2026-11-20", views: 5, uaBot: 9, source_linkedin: 3, source_direct: 2, device_desktop: 5, geo_US: 4, geo_GB: 1, edge_IAD: 4, edge_LHR: 1 },
    { pk: "VIEW#me.example#first-post", sk: "2026-11-10", views: 7 },
    { pk: "VIEW#me.example#first-post", sk: "REF#2026-11-20#linkedin.com", count: 3 },
    { pk: "VIEW#me.example#first-post", sk: "REF#2026-11-20#direct", count: 2 },
    { pk: "VIEW#me.example#second-post", sk: "2026-11-21", views: 8, geo_US: 8, edge_SFO: 8 },
    { pk: "VIEW#me.example#wp-login.php", sk: "2026-11-21", views: 400 },
    { pk: "HOME#me.example", sk: "2026-11-21", views: 3, geo_DE: 3 },
    { pk: "HOME#me.example", sk: "REF#2026-11-21#google.com", count: 3 },
    { pk: "POSTVIEW#me.example", sk: "2026-11-21#me.example#3p1", views: 4, geo_US: 4 },
    { pk: "POSTVIEW#me.example", sk: "2026-11-21#someone.else#3p9", views: 50 },
    { pk: "ENGAGE#at://did:plc:me/app.bsky.feed.post/3p1", sk: "2026-11-14", likes: 2, reposts: 0, replies: 0 },
    { pk: "ENGAGE#at://did:plc:me/app.bsky.feed.post/3p1", sk: "2026-11-21", likes: 9, reposts: 2, replies: 1 },
    { pk: "ACCT#did:plc:me", sk: "2026-11-10", followers: 200 },
    { pk: "ACCT#did:plc:me", sk: "2026-11-21", followers: 212 },
  ];
  const ddb = {
    send: async (cmd: any) => {
      if (cmd.input.Key) return { Item: { pk: "META#analytics", sk: "reprocessed", from: "2026-10-22" } };
      const { ExpressionAttributeValues: v } = cmd.input;
      const Items = items.filter(i => i.pk === v[":pk"] && (v[":start"] === undefined || (i.sk >= v[":start"] && i.sk <= v[":end"])))
        .sort((a, b) => a.sk.localeCompare(b.sk));
      return { Items };
    },
  };
  const fetchPosts = vi.fn(async () => new Response(JSON.stringify({ records: [
    { uri: "at://did:plc:me/app.bsky.feed.post/3p1", value: { text: "Hello there", createdAt: "2026-11-12T10:00:00Z" } },
    { uri: "at://did:plc:me/app.bsky.feed.post/3p2", value: { text: "Quiet one", createdAt: "2026-11-01T10:00:00Z" } },
  ] }), { headers: { "content-type": "application/json" } }));

  it("totals real pages, compares with the previous window and ranks content", async () => {
    const overview = await buildSiteOverview({
      ddb, analyticsTable: "reports", indexTable: "index", apexDid: "did:web:apex", fetch: fetchPosts as any,
      now: Date.parse("2026-11-21T12:00:00Z"),
    }, { did: "did:plc:me", handle: "me.example", host: "me.example" }, 7);
    expect(overview.days).toEqual(["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(overview.totals).toEqual({ articles: 13, home: 3, posts: 4 });
    expect(overview.previous).toEqual({ articles: 7, home: 0, posts: 0 });
    expect(overview.automated).toBe(9);
    expect(overview.articleCount).toBe(2);
    expect(overview.daily.at(-1)).toEqual({ day: "2026-11-21", articles: 8, home: 3, posts: 4 });
    expect(overview.topArticles.map(a => [a.title, a.views, a.previous])).toEqual([["Second", 8, 0], ["First", 5, 7]]);
    expect(overview.countries).toEqual([{ code: "US", views: 16 }, { code: "DE", views: 3 }, { code: "GB", views: 1 }]);
    expect(overview.cities[0]).toEqual({ code: "SFO", city: "San Francisco", country: "US", views: 8 });
    expect(overview.referrers).toEqual([{ host: "google.com", views: 3 }, { host: "linkedin.com", views: 3 }, { host: "direct", views: 2 }]);
    expect(overview.sources).toEqual({ linkedin: 3, direct: 2 });
    expect(overview.topPosts).toEqual([{ rkey: "3p1", text: "Hello there", url: "https://bsky.app/profile/did%3Aplc%3Ame/post/3p1",
      publishedAt: "2026-11-12T10:00:00Z", views: 4, engagement: 12, engagementGain: 10 }]);
    expect(overview.cleanFrom).toBe("2026-10-22");
    expect(overview.followers).toEqual({ count: 212, change: 12, day: "2026-11-21" });
  });
});
