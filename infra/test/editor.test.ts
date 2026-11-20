import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, Context, SQSEvent } from "aws-lambda";

const fixture = vi.hoisted(() => {
  process.env.DRAFTS_TABLE = "drafts";
  process.env.DOMAIN = "social.example.com";
  process.env.KNOWN_TENANT_HOSTS = "writer.example.com,second.example.com";
  process.env.SITE_SHARING_TABLE = "sharing";
  process.env.XRPC_ORIGIN = "https://origin.example.com";
  process.env.DRAFT_MEDIA_BUCKET = "draft-media";
  return {
    drafts: new Map<string, any>(),
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
            return { Item: structuredClone(fixture.drafts.get(key(command.input.Key as any))) };
          }
          if (command instanceof sdk.PutCommand) {
            const item = structuredClone(command.input.Item as any);
            const id = key(item);
            const current = fixture.drafts.get(id);
            const expected = command.input.ExpressionAttributeValues?.[":old"];
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
