import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, Context, SQSEvent } from "aws-lambda";

const fixture = vi.hoisted(() => {
  process.env.DRAFTS_TABLE = "drafts";
  process.env.DOMAIN = "social.example.com";
  process.env.KNOWN_TENANT_HOSTS = "writer.example.com,second.example.com";
  process.env.SITE_SHARING_TABLE = "sharing";
  process.env.XRPC_ORIGIN = "https://origin.example.com";
  process.env.DRAFT_MEDIA_BUCKET = "draft-media";
  process.env.LONGFORM_INDEX_TABLE = "articles";
  process.env.AP_LAUNCH_QUEUE_URL = "ap-launch-queue";
  process.env.AP_CUSTOM_HOSTS = "writer.example.com,second.example.com";
  return {
    drafts: new Map<string, any>(),
    index: new Map<string, any>(),
    shares: new Map<string, any>(),
    policies: new Map<string, object>(),
    media: new Map<string, Buffer>(),
    scheduled: [] as any[],
    messages: [] as string[],
  };
});

vi.mock("../lib/lambdas/auth/lib/jwt", () => ({
  verifyJwt: async (token: string) => ({ email: token }),
}));
vi.mock("../lib/lambdas/auth/entitlements", () => ({
  resolveApprovedDids: async (email: string) => [
    { did: `did:web:${email}`, handle: email },
    ...(email === "writer.example.com" ? [{ did: "did:web:second.example.com", handle: "second.example.com" }] : []),
  ],
}));
vi.mock("../lib/lambdas/auth/session-mint", () => ({
  mintFirstPartySessionFor: async (email: string, did: string) =>
    did === `did:web:${email}` ? { accessJwt: "pds-token" } : null,
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class { async send() { return { Parameter: { Value: "secret" } }; } },
  GetParameterCommand: class {},
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => {
  const sdk = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
  const key = (item: { did: string; id: string }) => `${item.did}/${item.id}`;
  const conflict = () => Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" });
  return {
    ...sdk,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(command: any) {
          if (command instanceof sdk.GetCommand) {
            if (command.input.TableName === "sharing") {
              return { Item: fixture.policies.get(`${command.input.Key?.pk}/${command.input.Key?.sk}`) };
            }
            if (command.input.TableName === "articles") {
              return { Item: structuredClone(fixture.index.get(`${command.input.Key?.pk}/${command.input.Key?.sk}`)) };
            }
            return { Item: structuredClone(fixture.drafts.get(key(command.input.Key as any))) };
          }
          if (command instanceof sdk.UpdateCommand && command.input.TableName === "articles") {
            const item = fixture.index.get(`${command.input.Key?.pk}/${command.input.Key?.sk}`);
            if (item?.item?.status !== "published" || !item.item.managedLaunch) throw conflict();
            const field = command.input.ExpressionAttributeNames?.["#field"]!;
            item[field] ??= structuredClone(command.input.ExpressionAttributeValues?.[":value"]);
            return {};
          }
          if (command instanceof sdk.PutCommand) {
            const item = structuredClone(command.input.Item as any);
            const id = key(item);
            const current = fixture.drafts.get(id);
            const expected = command.input.ExpressionAttributeValues?.[":old"] ?? command.input.ExpressionAttributeValues?.[":prior"];
            if (current?.version !== expected) throw conflict();
            fixture.drafts.set(id, item);
            // Preserve stale GSI snapshots to exercise the consistent read on link revocation.
            if (item.shareToken) fixture.shares.set(item.shareToken, { id: item.id, did: item.did });
            return {};
          }
          if (command instanceof sdk.QueryCommand && command.input.IndexName === "byShareToken") {
            const match = fixture.shares.get(command.input.ExpressionAttributeValues?.[":token"] as string);
            return { Items: match ? [match] : [] };
          }
          throw Error("Unexpected DynamoDB operation");
        },
      }),
    },
  };
});
vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...sdk,
    S3Client: class {
      async send(command: any) {
        if (command instanceof sdk.PutObjectCommand) {
          fixture.media.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
          return {};
        }
        if (command instanceof sdk.CopyObjectCommand) {
          const source = fixture.media.get(command.input.CopySource!.slice("draft-media/".length));
          if (!source) throw Error("Unknown source image");
          fixture.media.set(command.input.Key!, Buffer.from(source));
          return {};
        }
        const media = fixture.media.get(command.input.Key);
        if (!media) throw Error("Unknown draft image");
        return { Body: { transformToString: (encoding: BufferEncoding) => media.toString(encoding), transformToByteArray: () => media } };
      }
    },
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://private.example.com/signed-image",
}));
vi.mock("@aws-sdk/client-scheduler", async importOriginal => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-scheduler")>();
  return {
    ...sdk,
    SchedulerClient: class {
      async send(command: any) {
        if (command instanceof sdk.CreateScheduleCommand) fixture.scheduled.push(command.input);
        return {};
      }
    },
  };
});
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { async send(command: any) { fixture.messages.push(command.input.MessageBody); } },
  SendMessageCommand: class { constructor(readonly input: { MessageBody: string }) {} },
}));

import { handler as editor } from "../lib/lambdas/editor/handler";
import { handler as worker } from "../lib/lambdas/editor/worker";
import { emptyDraftFields, insertDraftImage, type EditorDraft, type PostKind } from "../editor";

it("inserts a diagram at the article cursor without removing surrounding prose", () => {
  const image = { id: "diagram", alt: "Two sites [one firehose]" };
  const marker = "![Two sites  one firehose ](draft-image:diagram)";
  expect(insertDraftImage("Before\n\nAfter", image, 6)).toEqual({
    content: `Before\n\n${marker}\n\nAfter`, cursor: 8 + marker.length,
  });
  expect(insertDraftImage("Before", image).content).toBe(`Before\n\n${marker}`);
});

const did = "did:web:writer.example.com";
async function request(method: string, path = "", payload?: object | Buffer, token: string | null = "writer.example.com", repo = did, host = "writer.example.com") {
  const url = new URL(`https://writer.example.com/auth/editor${path}`);
  if (!url.searchParams.has("did")) url.searchParams.set("did", repo);
  const result = await editor({
    version: "2.0", routeKey: "$default", rawQueryString: url.search.slice(1),
    rawPath: url.pathname,
    requestContext: { http: { method } },
    headers: { authorization: token ? `Bearer ${token}` : "", "x-pds-viewer-host": host },
    queryStringParameters: Object.fromEntries(url.searchParams),
    isBase64Encoded: Buffer.isBuffer(payload),
    body: Buffer.isBuffer(payload) ? payload.toString("base64") : JSON.stringify(payload),
  } as unknown as APIGatewayProxyEventV2);
  return { status: result.statusCode, body: result.body ?? "", headers: result.headers ?? {} };
}

async function create(kind: PostKind, rkey?: string): Promise<EditorDraft> {
  const result = await request("POST", "", { kind, rkey });
  expect(result.status).toBe(201);
  return JSON.parse(result.body);
}

function deliver(body: string, receiveCount = 1) {
  return worker({
    Records: [{ body, attributes: { ApproximateReceiveCount: String(receiveCount) } }],
  } as SQSEvent, {} as Context, () => undefined);
}

describe("editor authorization and publication", () => {
  beforeEach(() => {
    fixture.drafts.clear();
    fixture.shares.clear();
    fixture.media.clear();
    fixture.policies.clear();
    fixture.scheduled.length = 0;
    fixture.messages.length = 0;
    vi.stubGlobal("fetch", vi.fn());
  });

  it("stores images privately and revokes both shared HTML and media despite an out-of-date index", async () => {
    const draft = await create("longform");
    const identities = await request("GET", "/identities");
    const writer = { did, handle: "writer.example.com" };
    const second = { did: "did:web:second.example.com", handle: "second.example.com" };
    expect(JSON.parse(identities.body)).toEqual({ identities: [
      { ...writer, copyTargets: [second] }, { ...second, copyTargets: [writer] },
    ] });
    expect((await request("GET", `/${draft.id}`, undefined, null)).status).toBe(401);
    expect((await request("GET", `/${draft.id}`, undefined, "other.example.com")).status).toBe(403);
    expect((await request("GET", `/${draft.id}`, undefined, "other.example.com", "did:web:other.example.com")).status).toBe(404);
    expect((await request("POST", `/${draft.id}/media?version=1`, Buffer.from("<svg>"))).status).toBe(415);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const upload = await request("POST", `/${draft.id}/media?version=1`, png);
    expect(upload.status).toBe(200);
    const { version, fields } = JSON.parse(upload.body);
    const image = fields.images[0].id;
    const saved = await request("PUT", `/${draft.id}`, { version, fields: {
      ...fields, title: "<script>draft</script>", content: `Article.\n\n![photo](draft-image:${image})`,
    } });
    expect(saved.status).toBe(200);
    expect((await request("PUT", `/${draft.id}`, { version, fields })).status).toBe(409);
    const link = await request("POST", `/${draft.id}/share`, { version: version + 1, enabled: true });
    const shared = JSON.parse(link.body);
    const path = new URL(shared.shareUrl).pathname.slice("/auth/editor".length);
    const page = await request("GET", path, undefined, null);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(page.headers["x-robots-tag"]).toContain("noindex");
    expect(page.body).toContain(`${path}/media/${image}`);
    expect(page.body).not.toContain("<script>");
    expect((await request("GET", `${path}/media/${image}`, undefined, null)).body).toBe(png.toString("base64"));
    expect((await request("POST", `/${draft.id}/share`, { version: shared.version, enabled: false })).status).toBe(200);
    expect((await request("GET", path, undefined, null)).status).toBe(410);
    expect((await request("GET", `${path}/media/${image}`, undefined, null)).status).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies a draft read and copy across a disabled direction while the source remains editable", async () => {
    const draft = await create("longform");
    const target = "second.example.com";
    fixture.policies.set(`SITE_SHARING#${target}/writer.example.com`, { incoming: false, outgoing: true });
    const catalog = await request("GET", "/identities", undefined, "writer.example.com", did, target);
    expect(JSON.parse(catalog.body).identities.map((identity: { handle: string }) => identity.handle)).toEqual([target]);
    expect((await request("GET", `/${draft.id}`, undefined, "writer.example.com", did, target)).status).toBe(403);
    expect((await request("GET", `/${draft.id}`)).status).toBe(200);
    expect((await request("POST", `/${draft.id}/copy`, {
      version: draft.version, targetDid: `did:web:${target}`, requestId: "2f0a507d-55b0-4640-a1ee-c32adb0ea536",
    })).status).toBe(403);
  });

  it("ignores deliveries from a canceled or replaced schedule", async () => {
    const draft = await create("post");
    await request("PUT", `/${draft.id}`, { version: 1, fields: { ...emptyDraftFields(), content: "Private until due" } });
    const at = new Date(Date.now() + 180_000).toISOString();
    expect((await request("POST", `/${draft.id}/schedule`, { version: 2, at })).status).toBe(202);
    expect((await request("POST", `/${draft.id}/schedule`, { version: 3, at })).status).toBe(202);
    expect(fixture.scheduled).toHaveLength(2);
    expect(fixture.scheduled[0].ActionAfterCompletion).toBe("DELETE");
    expect(fixture.scheduled[0].Target.Input).not.toContain("Private until due");
    await deliver(fixture.scheduled[0].Target.Input);
    expect((await request("POST", `/${draft.id}/cancel`, { version: 4 })).status).toBe(200);
    await deliver(fixture.scheduled[1].Target.Input);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves the published record unchanged until a scheduled revision is due", async () => {
    const original = { $type: "app.bsky.feed.post", text: "Old text", createdAt: "2025-11-11T00:00:00Z",
      reply: { root: { uri: "at://original/post/root", cid: "old" } } };
    let updated: any;
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith(".getRecord")) {
        return Response.json({ cid: "original-cid", value: original });
      }
      updated = JSON.parse(init.body as string);
      return Response.json({ uri: `at://${did}/app.bsky.feed.post/${updated.rkey}`, cid: "next-cid" });
    }));
    const draft = await create("post", "original");
    expect(draft.fields.content).toBe("Old text");
    await request("PUT", `/${draft.id}`, { version: 1, fields: { ...draft.fields, content: "Edited text" } });
    const at = new Date(Date.now() + 180_000).toISOString();
    expect((await request("POST", `/${draft.id}/schedule`, { version: 2, at })).status).toBe(202);
    const job = fixture.scheduled[0].Target.Input;
    await expect(deliver(job)).rejects.toThrow("Publication attempt failed");
    expect(updated).toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse(at) + 1000);
      await deliver(job, 2);
    } finally { vi.useRealTimers(); }
    expect(updated.rkey).toBe("original");
    expect(updated.swapRecord).toBe("original-cid");
    expect(updated.record).toEqual({ ...original, text: "Edited text" });
  });

  it("saves, previews, publishes, and removes an optional video companion on an article revision", async () => {
    let record: { value: Record<string, unknown>; cid: string; uri: string } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith(".getRecord")) return record
        ? Response.json(record)
        : Response.json({ error: "RecordNotFound" }, { status: 400 });
      if (!url.pathname.endsWith(".putRecord")) throw Error("Unexpected XRPC");
      const saved = JSON.parse(init.body as string);
      record = { value: saved.record, cid: `cid-${record ? "edit" : "original"}`, uri: `at://${did}/${saved.collection}/${saved.rkey}` };
      return Response.json(record);
    }));
    const draft = await create("longform");
    const fields = { ...draft.fields, content: "The article", title: "Article and video" };
    const video = { url: "https://www.youtube.com/watch?v=M7lc1UVf-VE", title: 'Demo <script> "overview"' };
    expect((await request("PUT", `/${draft.id}`, {
      version: 1, fields: { ...fields, video: { url: "https://www.youtube.com.evil.example/watch?v=M7lc1UVf-VE" } },
    })).status).toBe(400);
    const post = await create("post");
    expect((await request("PUT", `/${post.id}`, { version: 1, fields: { ...post.fields, video } })).status).toBe(400);

    const save = await request("PUT", `/${draft.id}`, {
      version: 1, fields: { ...fields, video: { ...video, url: "https://youtu.be/M7lc1UVf-VE?si=tracking" }, managedLaunch: true },
    });
    expect(save.status).toBe(200);
    const saved: EditorDraft = JSON.parse(save.body);
    expect(JSON.parse((await request("GET", `/${draft.id}`)).body).fields).toMatchObject({ video, managedLaunch: true });
    const shared: EditorDraft = JSON.parse((await request("POST", `/${draft.id}/share`, { enabled: true, version: saved.version })).body);
    const share = await request("GET", new URL(shared.shareUrl!).pathname.replace("/auth/editor", ""), undefined, null);
    expect(share.status).toBe(200);
    expect(share.body).toContain(`href="${video.url}"`);
    expect(share.body).toContain("Demo &lt;script&gt; &quot;overview&quot;");
    expect(share.body).not.toContain("<iframe");
    expect(fetch).not.toHaveBeenCalled();

    expect((await request("POST", `/${draft.id}/publish`, { version: shared.version })).status).toBe(202);
    await deliver(fixture.messages[0]);
    expect(record?.value).toMatchObject({ video, managedLaunch: true, content: fields.content });
    const published: EditorDraft = JSON.parse((await request("GET", `/${draft.id}`)).body);
    const revision = await create("longform", published.result!.rkey);
    expect(revision.fields).toMatchObject({ video, managedLaunch: true });
    const revise = await request("PUT", `/${revision.id}`, {
      version: revision.version, fields: { ...revision.fields, video: undefined, managedLaunch: false },
    });
    expect(revise.status).toBe(200);
    const revised: EditorDraft = JSON.parse(revise.body);
    expect(revised.fields).not.toHaveProperty("video");
    expect(revised.fields.managedLaunch).toBe(true);
    expect((await request("POST", `/${revision.id}/publish`, { version: revised.version })).status).toBe(202);
    await deliver(fixture.messages[1]);
    expect(record?.value).not.toHaveProperty("video");
    expect(record?.value.managedLaunch).toBe(true);
  });

  it("reconciles a commit with a lost response without publishing a duplicate", async () => {
    let publicRecord: any;
    let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith(".getRecord")) return publicRecord
        ? Response.json(publicRecord)
        : Response.json({ error: "RecordNotFound" }, { status: 400 });
      if (!url.pathname.endsWith(".putRecord")) throw Error("Unexpected XRPC");
      const body = JSON.parse(init.body as string);
      expect(body.swapRecord).toBeNull();
      expect(body.repo).toBe(did);
      writes++;
      publicRecord = { uri: `at://${did}/${body.collection}/${body.rkey}`, cid: "published-cid", value: body.record };
      throw Error("Connection closed after write");
    }));
    const draft = await create("post");
    await request("PUT", `/${draft.id}`, { version: 1, fields: { ...emptyDraftFields(), content: "Publish once" } });
    expect((await request("POST", `/${draft.id}/publish`, { version: 2 })).status).toBe(202);
    expect(fixture.messages).toHaveLength(1);
    await expect(deliver(fixture.messages[0])).rejects.toThrow("Publication attempt failed");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await deliver(fixture.messages[0], 2);
      await deliver(fixture.messages[0], 3);
    } finally { vi.useRealTimers(); }
    expect(writes).toBe(1);
    const done = JSON.parse((await request("GET", `/${draft.id}`)).body);
    expect(done.state).toBe("published");
    expect(done.result.uri).toBe(publicRecord.uri);
  });
});

it("copies photos to an approved identity as an independent, idempotent private draft", async () => {
  const created = JSON.parse((await request("POST", "", { kind: "longform" })).body) as EditorDraft;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const withImage = JSON.parse((await request("POST", `/${created.id}/media?version=${created.version}`, png)).body) as EditorDraft;
  const saved = JSON.parse((await request("PUT", `/${created.id}`, {
    version: withImage.version, fields: { ...withImage.fields, title: "Copy", slug: "existing-slug", content: "body" },
  })).body) as EditorDraft;
  const shared = JSON.parse((await request("POST", `/${created.id}/share`, { version: saved.version, enabled: true })).body) as EditorDraft;
  const input = {
    version: shared.version,
    targetDid: "did:web:second.example.com",
    requestId: "d79baf35-8709-4c9c-92f9-85b561438fdc",
  };
  const action = `/${created.id}/copy`;
  expect((await request("POST", action, { ...input, targetDid: "did:web:other.example.com" })).status).toBe(403);
  const response = await request("POST", action, input);
  expect(response.status).toBe(201);
  const copy = JSON.parse(response.body) as EditorDraft;
  expect(copy).toMatchObject({ did: input.targetDid, state: "draft", fields: { title: "Copy", slug: "", images: shared.fields.images } });
  expect(copy.id).not.toBe(created.id);
  expect(copy.shareUrl).toBeUndefined();
  expect(copy.scheduledAt).toBeUndefined();
  expect(fixture.media.get(`${copy.id}/${copy.fields.images[0].id}`)).toEqual(png);
  expect(JSON.parse((await request("POST", action, input)).body).id).toBe(copy.id);
  expect((await request("GET", `/${copy.id}`)).status).toBe(404);
});

describe("managed article launches", () => {
  const key = "3mlaunchtest2";
  const canonical = "https://writer.example.com/article";
  const indexKey = `IDX#${did}/${key}`;
  const inputs = {
    bluesky: { enabled: true, text: "New writing ✨" },
    fediverse: { enabled: true, text: "For ActivityPub readers." },
  };

  beforeEach(() => {
    fixture.drafts.clear();
    fixture.index.clear();
    fixture.policies.clear();
    fixture.scheduled.length = 0;
    fixture.messages.length = 0;
    fixture.index.set(indexKey, { item: {
      rkey: key, currentSlug: "article", title: "Article", excerpt: "A short article",
      status: "published", managedLaunch: true, syndication: {}, publishedAt: "2026-11-19T19:00:00.000Z",
    } });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("requires site permissions and allows canceling a scheduled launch before its job runs", async () => {
    const path = `/launches/${key}`;
    const time = new Date(Date.now() + 3600_000).toISOString();
    const version = JSON.parse((await request("GET", path)).body).version;
    const result = await request("POST", path, { action: "launch", version, channels: inputs, at: time });
    expect(result.status).toBe(200);
    const scheduled = JSON.parse(result.body);
    expect(scheduled.run).toEqual({
      at: new Date(Math.ceil(Date.parse(time) / 1000) * 1000).toISOString(), platforms: ["bluesky", "fediverse"],
    });
    expect(fixture.messages).toHaveLength(0);
    expect((await request("GET", path, undefined, "second.example.com", did, "second.example.com")).status).toBe(403);
    fixture.policies.set("SITE_SHARING#writer.example.com/second.example.com", { outgoing: false });
    expect((await request("GET", path, undefined, "writer.example.com", did, "second.example.com")).status).toBe(403);
    expect((await request("POST", path, { action: "launch", version, channels: inputs })).status).toBe(409);
    expect((await request("POST", path, { action: "cancel", version: scheduled.version })).status).toBe(200);
    await deliver(fixture.scheduled[0].Target.Input);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.messages).toHaveLength(0);
  });

  it("checks canonical HTML, preserves partial success, and reconciles a Bluesky write that lost its response", async () => {
    let write: any;
    const calls = vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      if (input === canonical) {
        return new Response(`<html><head><link rel="canonical" href="${canonical}"></head></html>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.pathname.endsWith(".getRecord")) {
        if (!write) return Response.json({ error: "RecordNotFound" }, { status: 404 });
        expect(url.searchParams.get("rkey")).toBe(write.rkey);
        return Response.json({ uri: `at://${did}/app.bsky.feed.post/${write.rkey}`, cid: "posted-cid", value: write.record });
      }
      if (url.pathname.endsWith(".putRecord")) {
        expect(write).toBeUndefined();
        write = JSON.parse(options!.body as string);
        expect(write.swapRecord).toBeNull();
        expect(write.record.text).toBe("New writing ✨\n\n" + canonical + "?utm_source=bluesky");
        expect(write.record.facets[0].index.byteStart).toBe(Buffer.byteLength("New writing ✨\n\n"));
        throw new Error("PDS response lost after commit");
      }
      throw Error("Unexpected request");
    });

    const path = `/launches/${key}`;
    const first = JSON.parse((await request("POST", path, { action: "launch", version: 0, channels: inputs })).body);
    expect(first.run.platforms).toEqual(["bluesky", "fediverse"]);
    await deliver(fixture.messages[0]);
    const partial = JSON.parse((await request("GET", path)).body);
    expect(partial.channels.bluesky.state).toBe("failed");
    expect(partial.channels.fediverse).toMatchObject({
      state: "queued", url: `https://writer.example.com/ap/users/writer.example.com/articles/${key}`,
    });
    expect(JSON.parse(fixture.messages[1])).toEqual({
      kind: "event", event: { collection: "social.serverless.longform", did, launch: true, op: "create", rkey: key },
    });
    expect(fixture.index.get(indexKey).launchActivityPub.text).toBe(inputs.fediverse.text);

    const retry = JSON.parse((await request("POST", path, { action: "retry", version: partial.version })).body);
    expect(retry.run.platforms).toEqual(["bluesky"]);
    await deliver(fixture.messages[2]);
    await deliver(fixture.messages[0]);
    await deliver(fixture.messages[2]);
    const final = JSON.parse((await request("GET", path)).body);
    expect(final.channels.bluesky).toMatchObject({
      state: "posted", url: `https://bsky.app/profile/${encodeURIComponent(did)}/post/${write.rkey}`,
    });
    expect(fixture.index.get(indexKey).launchBluesky.cid).toBe("posted-cid");
    expect(final.channels.fediverse.state).toBe("queued");
    expect(final.run).toBeUndefined();
    expect(fixture.messages).toHaveLength(3);
    expect(calls.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith(".putRecord"))).toHaveLength(1);
  });

  it("blocks announcements when a 200 response is the app shell, and keeps automatic articles read-only", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html><head><title>App shell</title></head></html>", {
      headers: { "content-type": "text/html" },
    }));
    const path = `/launches/${key}`;
    expect((await request("POST", path, { action: "launch", version: 0, channels: inputs })).status).toBe(200);
    await deliver(fixture.messages[0], 4);
    const plan = JSON.parse((await request("GET", path)).body);
    expect(plan.channels.bluesky).toMatchObject({ state: "failed", error: expect.stringContaining("public article") });
    expect(plan.channels.fediverse.state).toBe("failed");
    expect(fixture.messages).toHaveLength(1);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(canonical, expect.objectContaining({ redirect: "error" }));

    fixture.index.get(indexKey).item.managedLaunch = undefined;
    const automatic = JSON.parse((await request("GET", path)).body);
    expect(automatic.mode).toBe("automatic");
    expect((await request("POST", path, { action: "launch", version: 0, channels: inputs })).status).toBe(409);
  });
});
