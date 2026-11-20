import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Secp256k1Keypair } from "@atproto/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationRequestState, createDirectMessagesClient, MESSAGES_PATH, messageLength, messageTooLong,
  type Conversation, type DirectMessage,
} from "../direct-messages";
import { createBlueskyChat, type BlueskyChat } from "../lib/lambdas/chat/bluesky";
import { createDirectMessageHandler } from "../lib/lambdas/chat/handler";
import { serviceAuthJwt } from "../lib/lambdas/pds/appview-proxy";

const wire = JSON.parse(readFileSync(join(__dirname, "fixtures/bluesky-chat.json"), "utf8"));
const tenant = { did: "did:plc:xxxxxxxxxxxxxxxxxxxxxxxx", handle: "writer.example" };
const owner = "fixture-owner@example.com";
const conversationId = "example-conversation";
const conversation = {
  id: conversationId,
  rev: "example-revision",
  status: "accepted",
  members: [wire.actor, wire.peer],
  lastMessage: wire.message,
  muted: false,
  unreadCount: 0,
};

function createEvent({
  method = "GET", path = MESSAGES_PATH, host = wire.actor.handle,
  token = "apex", params, query, body, origin,
}: {
  method?: string; path?: string; host?: string | null; token?: string | null;
  params?: Record<string, string>; query?: Record<string, string>; body?: object; origin?: string;
} = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: {
      ...(host && { "x-pds-viewer-host": host }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(origin && { Origin: origin }),
    },
    pathParameters: params,
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : undefined,
  } as APIGatewayProxyEventV2;
}

function stubApp() {
  const chat = {
    list: vi.fn(async () => ({ conversations: [], next: "next-page" })),
    messages: vi.fn(async () => ({ messages: [], profiles: [], next: undefined })),
    open: vi.fn(),
    send: vi.fn(),
    accept: vi.fn(),
  } satisfies BlueskyChat;
  const actorFor = vi.fn(async (email: string, host: string) => {
    if (email !== owner) return undefined;
    const identity = host === tenant.handle ? tenant : wire.actor;
    return { ...identity, signingKeyRef: "/private/fixture-signing-key" };
  });
  const handle = createDirectMessageHandler({
    async verify(token) {
      if (token === "apex" || token === "tenant") return { email: owner, siteHost: token === "apex" ? wire.actor.handle : tenant.handle };
      if (token === "oauth-sso") return { email: owner };
      if (token === "other-account") return { email: "other@example.com", siteHost: wire.actor.handle };
      throw new Error("invalid token");
    },
    actorFor,
    hosts: new Set([wire.actor.handle, tenant.handle]),
    chatFor: () => chat,
  });
  return { handle, actorFor, chat };
}

afterEach(() => vi.unstubAllGlobals());

describe("site-scoped Bluesky messages", () => {
  it("rejects absent and invalid site sessions before resolving a signing identity", async () => {
    const { handle, actorFor } = stubApp();
    for (const event of [createEvent({ token: null }), createEvent({ token: "invalid" })]) {
      const result = await handle(event);
      expect(result.statusCode).toBe(401);
      expect(result.headers["cache-control"]).toBe("private, no-store");
    }
    for (const event of [
      createEvent({ host: null }),
      createEvent({ host: tenant.handle }),
      createEvent({ token: "tenant" }),
      createEvent({ token: "oauth-sso" }),
      createEvent({ host: "unknown.example" }),
      createEvent({ origin: "https://foreign.example" }),
    ]) {
      expect(await handle(event)).toMatchObject({ statusCode: 403, body: expect.stringContaining("site_session_required") });
    }
    expect(actorFor).not.toHaveBeenCalled();
  });

  it("selects the current site's identity from the authenticated account and returns no key material", async () => {
    const { handle, actorFor, chat } = stubApp();
    expect(await handle(createEvent({ token: "other-account" }))).toMatchObject({ statusCode: 403 });
    expect(chat.list).not.toHaveBeenCalled();
    const result = await handle(createEvent({ token: "tenant", host: tenant.handle, query: { cursor: "page-3" } }));
    expect(actorFor).toHaveBeenLastCalledWith(owner, tenant.handle);
    expect(chat.list).toHaveBeenCalledWith(tenant.did, "page-3");
    expect(JSON.parse(result.body)).toEqual({ actor: tenant, conversations: [], next: "next-page" });
    expect(result.headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects actor overrides, invalid IDs, cursors, recipients, and invalid compose before any chat call", async () => {
    const { handle, chat } = stubApp();
    const path = `${MESSAGES_PATH}/conversations/${conversationId}`;
    const params = { conversationId };
    for (const event of [
      createEvent({ query: { did: tenant.did } }),
      createEvent({ query: { cursor: "bad\nvalue" } }),
      createEvent({ path, params: { conversationId: ".." } }),
      createEvent({ method: "POST", path: `${MESSAGES_PATH}/conversations`, body: { handle: "https://untrusted.example" } }),
      createEvent({ method: "POST", path, params, body: { text: " " } }),
      createEvent({ method: "POST", path, params, body: { text: "a".repeat(1001) } }),
      createEvent({ method: "POST", path, params, body: { text: "hi", did: tenant.did } }),
      createEvent({ method: "POST", path, params, body: { text: "hi", action: "accept" } }),
    ]) {
      expect(await handle(event)).toMatchObject({ statusCode: 400, body: expect.stringContaining("invalid_input") });
    }
    for (const method of Object.values(chat)) expect(method).not.toHaveBeenCalled();
  });

  it("normalizes a new recipient and routes authenticated reads and text writes", async () => {
    const { handle, chat } = stubApp();
    chat.open.mockResolvedValue({ id: conversationId, participants: [wire.actor, wire.peer] });
    chat.send.mockResolvedValue({ id: wire.sent.id, kind: "text", senderDid: wire.actor.did, text: wire.sent.text, sentAt: wire.sent.sentAt });
    const recipientPath = `${MESSAGES_PATH}/conversations`;
    const path = `${recipientPath}/${conversationId}`;
    const params = { conversationId };
    await expect(handle(createEvent({ method: "POST", path: recipientPath, body: { handle: " @Reader.Bsky.Social " } }))).resolves.toMatchObject({ statusCode: 200 });
    await expect(handle(createEvent({ path, params, query: { cursor: "before" } }))).resolves.toMatchObject({ statusCode: 200 });
    await expect(handle(createEvent({ method: "POST", path, params, body: { text: "line one\nline two" } }))).resolves.toMatchObject({ statusCode: 200 });
    expect(chat.messages).toHaveBeenCalledWith(wire.actor.did, conversationId, "before");
    expect(chat.open).toHaveBeenCalledWith(wire.actor.did, wire.peer.handle);
    expect(chat.send).toHaveBeenCalledWith(wire.actor.did, conversationId, "line one\nline two");
  });

  it("keeps private error details out of a failed send response", async () => {
    const { handle, chat } = stubApp();
    chat.send.mockRejectedValue(new Error("private diagnostic and message body"));
    const result = await handle(createEvent({
      path: `${MESSAGES_PATH}/conversations/${conversationId}`, method: "POST",
      params: { conversationId }, body: { text: wire.sent.text },
    }));
    expect(result).toMatchObject({ statusCode: 503, body: expect.stringContaining("send_uncertain") });
    expect(result.body).not.toContain("private diagnostic");
    expect(result.body).not.toContain(wire.sent.text);
  });

  it("only dispatches an explicit acceptance for the signed-in site's actor", async () => {
    const { handle, chat } = stubApp();
    const path = `${MESSAGES_PATH}/conversations/${conversationId}`;
    const params = { conversationId };
    await expect(handle(createEvent({
      method: "POST", host: tenant.handle, path, params, body: { action: "accept" },
    }))).resolves.toMatchObject({ statusCode: 403 });
    expect(chat.accept).not.toHaveBeenCalled();
    const result = await handle(createEvent({
      method: "POST", host: tenant.handle, token: "tenant", path, params, body: { action: "accept" },
    }));
    expect(result).toMatchObject({ statusCode: 200, body: JSON.stringify({ accepted: true }) });
    expect(chat.accept).toHaveBeenCalledWith(tenant.did, conversationId);
    expect(chat.send).not.toHaveBeenCalled();
  });
});

describe("Bluesky Chat XRPC", () => {
  it("uses method-bound signing, fixed service endpoints, cursors, and sanitized wire projections", async () => {
    const key = await Secp256k1Keypair.create();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ convos: [conversation], cursor: "next-list" }))
      .mockResolvedValueOnce(Response.json({ messages: [wire.message, wire.deleted], relatedProfiles: [wire.peer], cursor: "next-thread" }))
      .mockResolvedValueOnce(Response.json(wire.peer))
      .mockResolvedValueOnce(Response.json({ convo: conversation }))
      .mockResolvedValueOnce(Response.json(wire.sent));
    const chat = createBlueskyChat({
      fetcher,
      sign: (actor, method, audience) => serviceAuthJwt(key, method, audience, actor),
    });
    const listed = await chat.list(wire.actor.did, "prev-list");
    const thread = await chat.messages(wire.actor.did, conversationId, "prev-thread");
    const opened = await chat.open(wire.actor.did, wire.peer.handle);
    const sent = await chat.send(wire.actor.did, conversationId, wire.sent.text);
    expect(listed).toMatchObject({ next: "next-list", conversations: [{ id: conversationId }] });
    expect(thread.messages).toEqual([
      { kind: "text", id: wire.message.id, senderDid: wire.peer.did, text: wire.message.text, sentAt: wire.message.sentAt },
      { kind: "deleted", id: wire.deleted.id, senderDid: wire.actor.did, sentAt: wire.deleted.sentAt },
    ]);
    expect(thread.profiles[0]).toEqual({ did: wire.peer.did, handle: wire.peer.handle, displayName: wire.peer.displayName });
    expect(thread.next).toBe("next-thread");
    expect(opened.id).toBe(conversationId);
    expect(sent).toMatchObject({ senderDid: wire.actor.did, id: wire.sent.id, text: wire.sent.text });

    const chatCalls = fetcher.mock.calls.filter(([url]) => (url as URL).host === "api.bsky.chat");
    expect(chatCalls).toHaveLength(4);
    const jtis = chatCalls.map(([requested, init]) => {
      const url = requested as URL;
      const [header, payload] = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length).split(".");
      expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "ES256K" });
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
      expect(claims).toMatchObject({ iss: wire.actor.did, aud: "did:web:api.bsky.chat", lxm: url.pathname.slice("/xrpc/".length) });
      expect(claims.exp - claims.iat).toBe(60);
      return claims.jti;
    });
    expect(new Set(jtis).size).toBe(4);
    expect((chatCalls[0][0] as URL).searchParams.get("cursor")).toBe("prev-list");
    expect((chatCalls[1][0] as URL).searchParams.get("cursor")).toBe("prev-thread");
    expect((chatCalls[2][0] as URL).searchParams.getAll("members")).toEqual([wire.peer.did]);
    expect(JSON.parse(chatCalls[3][1]?.body as string)).toEqual({ convoId: conversationId, message: { text: wire.sent.text } });
    const publicProfileRequest = fetcher.mock.calls[2];
    expect((publicProfileRequest[0] as URL).origin).toBe("https://public.api.bsky.app");
    expect(new Headers(publicProfileRequest[1]?.headers).has("authorization")).toBe(false);
  });

  it("distinguishes denied provider auth, rate limits, wrong memberships, and uncertain delivery", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "InvalidToken", message: "private error" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: "RateLimitExceeded" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ convos: [{ ...conversation, members: [wire.peer] }] }))
      .mockRejectedValueOnce(new Error("private exception"))
      .mockResolvedValueOnce(Response.json({ error: "InvalidConvo" }, { status: 400 }));
    const chat = createBlueskyChat({ fetcher, sign: async () => "signed-fixture" });
    await expect(chat.list(wire.actor.did)).rejects.toMatchObject({ status: 503, code: "chat_not_authorized" });
    await expect(chat.list(wire.actor.did)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(chat.list(wire.actor.did)).rejects.toMatchObject({ status: 503, code: "chat_unavailable" });
    await expect(chat.send(wire.actor.did, conversationId, wire.sent.text)).rejects.toMatchObject({ status: 503, code: "send_uncertain" });
    await expect(chat.messages(wire.actor.did, conversationId)).rejects.toMatchObject({ status: 403, code: "conversation_unavailable" });
  });

  it("projects direct and group kinds and accepts through the separate Bluesky procedure", async () => {
    const inbox = [{ ...conversation, status: "request", kind: { $type: "chat.bsky.convo.defs#groupConvo", name: "Fixture group" } },
      { ...conversation, status: "request", lastMessage: undefined, kind: { $type: "chat.bsky.convo.defs#directConvo" } }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ convos: inbox }))
      .mockResolvedValueOnce(Response.json({ rev: "accepted-revision" }));
    const sign = vi.fn(async () => "signed-fixture");
    const chat = createBlueskyChat({ fetcher, sign });
    const { conversations } = await chat.list(wire.actor.did);
    expect(conversations.map(row => row.kind)).toEqual(["group", "direct"]);
    await chat.accept(wire.actor.did, conversationId);
    expect(sign).toHaveBeenLastCalledWith(wire.actor.did, "chat.bsky.convo.acceptConvo", "did:web:api.bsky.chat");
    expect(fetcher).toHaveBeenLastCalledWith(new URL("https://api.bsky.chat/xrpc/chat.bsky.convo.acceptConvo"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ convoId: conversationId }) }));
  });
});

describe("browser message gateway", () => {
  it("distinguishes a new empty outgoing direct chat from incoming requests and incomplete history", () => {
    const recipient = { did: wire.peer.did, handle: wire.peer.handle };
    const outgoing: Conversation = {
      id: conversationId, participants: [wire.actor, recipient], status: "request", kind: "direct",
    };
    const incomingMessage: DirectMessage = {
      kind: "text", id: wire.message.id, senderDid: recipient.did, text: wire.message.text, sentAt: wire.message.sentAt,
    };
    expect(conversationRequestState(outgoing)).toBe("loading");
    expect(conversationRequestState(outgoing, { messages: [] })).toBe("outgoing");
    expect(conversationRequestState({ ...outgoing, kind: undefined }, { messages: [] })).toBe("outgoing");
    expect(conversationRequestState(outgoing, { messages: [], next: "earlier" })).toBe("incoming");
    expect(conversationRequestState(outgoing, { messages: [incomingMessage] })).toBe("incoming");
    expect(conversationRequestState({ ...outgoing, lastMessage: incomingMessage })).toBe("incoming");
    expect(conversationRequestState({ ...outgoing, kind: "group" }, { messages: [] })).toBe("incoming");
    expect(conversationRequestState({ ...outgoing, status: "accepted" })).toBeUndefined();
  });

  it("only sends a bearer session to the private API and never retries a send", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture lost response"));
    vi.stubGlobal("fetch", fetcher);
    const client = createDirectMessagesClient(() => "signed-session", "https://publisher.example");
    await expect(client.send(conversationId, "Fixture reply")).rejects.toMatchObject({ code: "send_uncertain" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(new URL(`https://publisher.example${MESSAGES_PATH}/conversations/${conversationId}`), {
      method: "POST", headers: { Authorization: "Bearer signed-session", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Fixture reply" }), cache: "no-store", credentials: "same-origin",
      redirect: "error", referrerPolicy: "no-referrer", signal: undefined,
    });
  });

  it("enforces provider grapheme and encoded byte limits", () => {
    expect(messageLength("👨‍👦‍👦")).toBe(1);
    expect(messageTooLong("👨‍👦‍👦".repeat(1000))).toBe(true);
    expect(messageTooLong("é".repeat(1000))).toBe(false);
    expect(messageTooLong("a".repeat(1001))).toBe(true);
  });
});
