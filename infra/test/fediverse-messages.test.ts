import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEDIVERSE_MESSAGES_PATH } from "../fediverse-messages";
import { dispatch, type ApDeps, type ApRequest } from "../lib/lambdas/ap/handler";
import { signRequest, verifyRequest } from "../lib/lambdas/ap/httpsig";
import { makePrivateMentionAuthenticator, makePrivateMentionStore } from "../lib/lambdas/ap-deps";
import {
  privateMessageKey, type MentionRow, type PrivateMentionActor, type PrivateMentionPorts, type PrivateMentionStore,
} from "../lib/lambdas/ap/private-mentions";

const createKeys = () => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const [publisher, remoteKeys] = [createKeys(), createKeys()];
const apex: PrivateMentionActor = { did: "did:web:serverless.social", handle: "serverless.social", origin: "https://serverless.social" };
const secondary: PrivateMentionActor = { did: "did:plc:example", handle: "martzmakes.com", origin: "https://martzmakes.com" };
const actorId = (actor: PrivateMentionActor) => `${actor.origin}/ap/users/${actor.handle}`;
const remote = "https://mastodon.example/users/matt";
const remoteInbox = remote + "/inbox";
const remoteStatus = remote + "/statuses/123";
const remoteAcct = "@matt@mastodon.example";
const remoteDoc = { type: "Person", id: remote, inbox: remoteInbox, preferredUsername: "matt",
  endpoints: { sharedInbox: "https://mastodon.example/inbox" } };

function memoryStore(): PrivateMentionStore {
  const data = new Map<string, MentionRow>();
  return {
    get: async (did, id) => data.get(`${did}/${id}`),
    async create(did, row) {
      const key = `${did}/${row.id}`;
      if (data.has(key)) return false;
      data.set(key, row);
      return true;
    },
    async replace(did, row) {
      const key = `${did}/${row.id}`;
      if (data.get(key)?.version !== row.version - 1) return false;
      data.set(key, row);
      return true;
    },
    list: async did => ({
      messages: [...data.entries()].filter(([key]) => key.startsWith(`${did}/`)).map(([, row]) => row),
    }),
  };
}

function fixture() {
  const outbox = vi.fn(async () => ({ records: [] }));
  const deliver = vi.fn<PrivateMentionPorts["deliver"]>(async () => ({ status: 202 }));
  const publicIngest = vi.fn(async () => true);
  const ports: PrivateMentionPorts = {
    store: memoryStore(), deliver, signRequest,
    getApKey: async () => ({ privatePem: publisher.privateKey }),
    fetchJson: async () => ({ links: [{ rel: "self", href: remote }] }),
    fetchActorJson: async () => remoteDoc,
    authenticate: async (authorization, host, origin) => {
      const owner = [apex, secondary].find(actor => actor.handle === host && authorization === `Bearer ${actor.handle}`);
      return owner && (!origin || origin === owner.origin) ? owner : undefined;
    },
  };
  const deps: ApDeps = {
    tenantStore: {
      byHandle: async handle => handle === secondary.handle ? { ...secondary, status: "active" } : null,
      byDid: async () => null,
      listActive: async () => [],
    },
    customHosts: [secondary.handle], privateMentions: ports,
    getApKey: async () => ({ privatePem: publisher.privateKey, publicPem: publisher.publicKey }),
    verifyRequest, signRequest,
    fetchRemoteActor: async () => ({ id: remote, inbox: remoteInbox, publicKeyPem: remoteKeys.publicKey }),
    deliverActivity: async () => { throw new Error("Private traffic must bypass public delivery"); },
    actorCache: { get: async () => null, put: async () => {} },
    followers: { add: async () => {}, remove: async () => {}, list: async () => [] },
    listOutbox: outbox,
    countOutbox: async () => 0,
    getOutboxPost: async () => null,
    fetchJson: async () => null,
    following: {
      get: async () => ({ state: "accepted", actorId: remote, inbox: remoteInbox, followId: "id",
        acct: remoteAcct, followers: remote + "/followers", createdAt: Date.now() }),
      put: async () => {},
      setAccepted: async () => true,
      remove: async () => {},
      list: async () => [],
    },
    inbound: { putIfAbsent: publicIngest, update: publicIngest, remove: publicIngest, page: async () => ({ records: [] }) },
  };
  return { deps, ports, deliver, publicIngest };
}

function owner(actor: PrivateMentionActor, method = "GET", body?: object, headers?: Record<string, string>): ApRequest {
  return { method, path: FEDIVERSE_MESSAGES_PATH, url: actor.origin + FEDIVERSE_MESSAGES_PATH, query: {},
    headers: { authorization: `Bearer ${actor.handle}`, "x-pds-viewer-host": actor.handle, origin: actor.origin, ...headers },
    rawBody: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) };
}

async function inbound(actor: PrivateMentionActor, activity: object): Promise<ApRequest> {
  const url = actorId(actor) + "/inbox";
  const rawBody = Buffer.from(JSON.stringify(activity));
  const signed = await signRequest({ method: "POST", url, body: rawBody, privateKeyPem: remoteKeys.privateKey, keyId: remote + "#main-key" });
  return { method: "POST", url, path: new URL(url).pathname, query: {}, rawBody,
    headers: Object.fromEntries(Object.entries(signed).map(([key, value]) => [key.toLowerCase(), value])) };
}

const create = (actor: PrivateMentionActor) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: remoteStatus + "/activity", actor: remote, type: "Create", to: [actorId(actor)], cc: [],
  object: { type: "Note", id: remoteStatus, attributedTo: remote, to: [actorId(actor)], cc: [],
    tag: [{ type: "Mention", href: actorId(actor) }],
    content: "<p>Private <b>hello</b><script>drop this</script><img src='https://tracker.example/pixel'></p><p>A &amp; B<br>Next line</p>" },
});

afterEach(() => vi.unstubAllEnvs());

describe("Fediverse private mentions", () => {
  it.each([apex, secondary])("accepts a real signed direct Note and signs a one-recipient response from $handle", async actor => {
    const { deps, deliver, publicIngest } = fixture();
    const signed = await inbound(actor, create(actor));
    expect((await dispatch(signed, deps)).status).toBe(202);
    expect((await dispatch(signed, deps)).status).toBe(202);
    expect(publicIngest).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    const page = await dispatch(owner(actor), deps);
    expect(page.headers?.["cache-control"]).toBe("private, no-store");
    const { messages } = JSON.parse(page.body);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: expect.stringMatching(/^in-/), peer: remoteAcct, direction: "received",
      status: "received", text: "Private hello\n\nA & B\nNext line", sentAt: expect.any(String) });
    const other = actor === apex ? secondary : apex;
    expect(JSON.parse((await dispatch(owner(other), deps)).body).messages).toEqual([]);
    expect((await dispatch(owner(other, "GET", undefined, { authorization: `Bearer ${actor.handle}` }), deps)).status).toBe(403);

    deliver.mockImplementation(async (url, body, headers) => {
      expect(url).toBe(remoteInbox);
      expect(await verifyRequest({ method: "POST", path: new URL(url).pathname, headers, body }, publisher.publicKey)).toBe(true);
      const packet = JSON.parse(body.toString());
      expect(packet).toMatchObject({ type: "Create", actor: actorId(actor), to: [remote], object: {
        type: "Note", attributedTo: actorId(actor), to: [remote], cc: [], inReplyTo: remoteStatus,
        tag: [{ type: "Mention", href: remote, name: remoteAcct }],
      } });
      expect(packet.object.content).toContain("Reply &lt;script&gt;");
      const path = new URL(packet.object.id).pathname;
      const publicGet = await dispatch({ ...owner(actor), path, url: packet.object.id, headers: { accept: "application/activity+json" } }, deps);
      expect(publicGet.status).toBe(404);
      expect(publicGet.body).not.toContain("Reply");
      return { status: 202 };
    });
    const reply = { replyTo: messages[0].id, text: "Reply <script>", requestId: randomUUID() };
    expect((await dispatch(owner(other, "POST", reply), deps)).status).toBe(422);
    const sent = await dispatch(owner(actor, "POST", reply), deps);
    expect(JSON.parse(sent.body).message).toMatchObject({ direction: "sent", status: "accepted" });
    expect(JSON.parse((await dispatch(owner(actor, "POST", reply), deps)).body).message.status).toBe("accepted");
    expect(deliver).toHaveBeenCalledTimes(1);
    const outbox = await dispatch({
      ...owner(actor), path: `${new URL(actorId(actor)).pathname}/outbox`, query: { page: "true" },
    }, deps);
    expect(outbox.body).not.toContain("Private hello");
    expect(outbox.body).not.toContain("Reply");
  });

  it("ignores multi-recipient and conflicting audiences, enforces signatures, and removes withdrawn messages", async () => {
    const { deps, publicIngest } = fixture();
    const direct = create(apex);
    const group = { ...direct, to: [actorId(apex), actorId(secondary)],
      object: { ...direct.object, to: [actorId(apex), actorId(secondary)] } };
    const conflicting = { ...direct, object: { ...direct.object, to: ["https://www.w3.org/ns/activitystreams#Public"] } };
    for (const candidate of [group, conflicting]) {
      expect((await dispatch(await inbound(apex, candidate), deps)).status).toBe(202);
      expect(JSON.parse((await dispatch(owner(apex), deps)).body).messages).toEqual([]);
    }
    expect(publicIngest).not.toHaveBeenCalled();
    const request = await inbound(apex, direct);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await dispatch({ ...request, rawBody: Buffer.concat([request.rawBody, Buffer.from(" ")]) }, deps)).status).toBe(401);
      expect(log.mock.calls.flat()).not.toContain(expect.stringContaining("Private hello"));
    } finally { log.mockRestore(); }
    expect(JSON.parse((await dispatch(owner(apex), deps)).body).messages).toEqual([]);
    await dispatch(request, deps);
    const revised = { ...direct, type: "Update", object: {
      ...direct.object, updated: new Date(Date.now() + 60_000).toISOString(), content: "Revised private text",
    } };
    await dispatch(await inbound(apex, revised), deps);
    expect(JSON.parse((await dispatch(owner(apex), deps)).body).messages[0].text).toBe("Revised private text");
    await dispatch(await inbound(apex, { type: "Delete", actor: remote, object: { id: remoteStatus, type: "Tombstone" } }), deps);
    await dispatch(request, deps);
    expect(JSON.parse((await dispatch(owner(apex), deps)).body).messages).toEqual([]);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it("keeps retries private, reuses the exact delivery body, and refuses a shared-inbox fallback", async () => {
    const { deps, ports, deliver } = fixture();
    const syslog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      deliver.mockRejectedValueOnce(new Error("Private text from an upstream response"));
      const input = { recipient: remoteAcct, text: "Private text", requestId: randomUUID() };
      const response = await dispatch(owner(apex, "POST", input), deps);
      const { message } = JSON.parse(response.body);
      expect(message.status).toBe("uncertain");
      expect((await dispatch(owner(apex, "POST", { ...input, text: "Changed content" }), deps)).status).toBe(409);
      expect((await dispatch(owner(secondary, "POST", { retry: message.id }), deps)).status).toBe(422);
      expect(JSON.parse((await dispatch(owner(apex, "POST", { retry: message.id }), deps)).body).message.status).toBe("accepted");
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver.mock.calls[0][1]).toEqual(deliver.mock.calls[1][1]);
      expect(syslog).not.toHaveBeenCalled();
      ports.fetchActorJson = async () => ({ ...remoteDoc, inbox: undefined });
      expect((await dispatch(owner(apex, "POST", { ...input, requestId: randomUUID() }), deps)).status).toBe(422);
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally { syslog.mockRestore(); }
  });
});

it("reads only the signed site’s identity and confirms tenant ownership on the base table", async () => {
  vi.stubEnv("DOMAIN", apex.handle);
  vi.stubEnv("KNOWN_TENANT_HOSTS", secondary.handle);
  vi.stubEnv("ALLOWED_EMAILS", "author@example.com");
  vi.stubEnv("TENANTS_TABLE", "tenants");
  const tenant = { ...secondary, status: "active", email: "author@example.com" };
  const read = vi.fn(async (_command: { input: Record<string, unknown> }) => ({ Item: tenant }));
  const verify = vi.fn(async (token: string) => ({ email: "author@example.com", siteHost: token }));
  const authenticate = makePrivateMentionAuthenticator({ send: read }, {
    byHandle: async () => tenant, byDid: async () => null, listActive: async () => [],
  }, [secondary.handle], verify);
  expect(await authenticate(`Bearer ${apex.handle}`, apex.handle, apex.origin)).toEqual(apex);
  expect(await authenticate(`Bearer ${apex.handle}`, secondary.handle, secondary.origin)).toBeUndefined();
  expect(await authenticate(`Bearer ${secondary.handle}`, secondary.handle, apex.origin)).toBeUndefined();
  expect(await authenticate(`Bearer ${secondary.handle}`, secondary.handle, secondary.origin)).toEqual(secondary);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0][0].input).toMatchObject({ TableName: "tenants", Key: { did: secondary.did }, ConsistentRead: true });
  tenant.email = "new-owner@example.com";
  expect(await authenticate(`Bearer ${secondary.handle}`, secondary.handle, secondary.origin)).toBeUndefined();
});

it("writes the private message and claim atomically and scopes a forged cursor to the caller’s partition", async () => {
  const ddb = { send: vi.fn(async (_command: { input: Record<string, unknown> }) => ({})) };
  const store = makePrivateMentionStore(ddb, "private-only");
  const row: MentionRow = {
    id: "out-" + randomUUID(), text: "body", peer: remoteAcct, peerId: remote, direction: "sent",
    sentAt: "2026-11-18T12:45:00.000Z", status: "sending", objectId: remoteStatus, version: 1,
  };
  expect(await store.create(apex.did, row)).toBe(true);
  const transaction = ddb.send.mock.calls[0][0].input;
  expect(transaction).toMatchObject({ TransactItems: [
    { Put: { TableName: "private-only", Item: { pk: apex.did, sk: "REF#" + row.id, messageKey: privateMessageKey(row) } } },
    { Put: { TableName: "private-only", Item: { pk: apex.did, sk: privateMessageKey(row), message: row } } },
  ] });
  await store.list(secondary.did, privateMessageKey(row));
  expect(ddb.send.mock.calls[1][0].input).toMatchObject({
    TableName: "private-only", ExclusiveStartKey: { pk: secondary.did, sk: privateMessageKey(row) },
    ExpressionAttributeValues: { ":did": secondary.did, ":prefix": "MSG#" }, ScanIndexForward: false,
  });
});
