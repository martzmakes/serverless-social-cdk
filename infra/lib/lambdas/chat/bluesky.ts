import { isValidDid } from "@atproto/syntax";
import type {
  ChatProfile, Conversation, DirectMessage, MessageErrorCode,
} from "../../../direct-messages";

const CHAT_ORIGIN = "https://api.bsky.chat";
// The reference PDS uses the bare DID in the outbound JWT, even when the
// client-facing proxy selector includes the #bsky_chat service fragment.
const CHAT_AUDIENCE = "did:web:api.bsky.chat";
const PROFILE_ORIGIN = "https://public.api.bsky.app";
const CHAT_TIMEOUT_MS = 8_000;
const PAGE_SIZE = "25";
const DEFS = "chat.bsky.convo.defs";
const METHODS = {
  list: "chat.bsky.convo.listConvos",
  messages: "chat.bsky.convo.getMessages",
  open: "chat.bsky.convo.getConvoForMembers",
  send: "chat.bsky.convo.sendMessage",
} as const;

export class ChatFailure extends Error {
  constructor(readonly status: number, readonly code: MessageErrorCode, message: string) {
    super(message);
  }
}

const unavailable = () => new ChatFailure(503, "chat_unavailable", "Bluesky Chat is temporarily unavailable.");
const sendUncertain = () => new ChatFailure(503, "send_uncertain",
  "Delivery could not be confirmed. Refresh the conversation before trying again.");

function providerFailure(status: number, code: string | undefined, isSend: boolean) {
  if (status === 401 || (status === 403 && !code) || code === "ChatDisabled") {
    return new ChatFailure(503, "chat_not_authorized", "Bluesky Chat is unavailable for this site's Bluesky identity.");
  }
  if (status === 429) {
    return new ChatFailure(429, "rate_limited", "Bluesky Chat is receiving too many requests. Try again shortly.");
  }
  switch (code) {
    case "RecipientNotFound":
      return new ChatFailure(400, "recipient_unavailable", "Couldn’t find that Bluesky account.");
    case "AccountSuspended":
    case "BlockedActor":
    case "BlockedSubject":
    case "MessagesDisabled":
    case "NotFollowedBySender":
      return new ChatFailure(403, "recipient_unavailable", "Bluesky’s messaging settings prevent starting this conversation.");
    case "ConvoLocked":
      return new ChatFailure(403, "conversation_unavailable", "This conversation is locked.");
    case "InvalidConvo":
      return new ChatFailure(403, "conversation_unavailable", "This conversation is unavailable.");
  }
  if (status === 403) {
    return new ChatFailure(503, "chat_not_authorized", "Bluesky Chat is unavailable for this site's Bluesky identity.");
  }
  if (status === 400) {
    return new ChatFailure(400, "invalid_input", "Bluesky Chat declined this request. Refresh and try again.");
  }
  return isSend ? sendUncertain() : unavailable();
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value) throw unavailable();
  return value;
}

function array(value: unknown) {
  if (!Array.isArray(value)) throw unavailable();
  return value as unknown[];
}

function did(value: unknown) {
  const result = requiredString(value);
  if (!isValidDid(result)) throw unavailable();
  return result;
}

export function validConversationId(value?: string): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~:-]{1,160}$/.test(value) && value !== "." && value !== "..";
}

export function validChatCursor(value: string) {
  return value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value);
}

function pageCursor(raw: unknown, requested?: string) {
  if (typeof raw !== "string" || raw === requested || !validChatCursor(raw)) return;
  return raw;
}

function profile(value: unknown): ChatProfile {
  const row = record(value);
  return {
    did: did(row.did),
    handle: requiredString(row.handle),
    ...(typeof row.displayName === "string" && row.displayName.trim() ? { displayName: row.displayName } : {}),
  };
}

function message(value: unknown): DirectMessage {
  const row = record(value);
  const id = requiredString(row.id);
  const sentAt = requiredString(row.sentAt);
  if (!Number.isFinite(Date.parse(sentAt))) throw unavailable();
  if (row.$type === `${DEFS}#systemMessageView`) return { kind: "activity", id, sentAt };
  const senderDid = did(record(row.sender).did);
  if (row.$type === `${DEFS}#deletedMessageView`) return { kind: "deleted", id, sentAt, senderDid };
  if (typeof row.text !== "string") throw unavailable();
  // Text may be empty on an embed-only message from the official client.
  return { kind: "text", id, senderDid, sentAt, text: row.text };
}

function conversation(value: unknown, actor: string): Conversation {
  const row = record(value);
  const id = typeof row.id === "string" ? row.id : undefined;
  if (!validConversationId(id)) throw unavailable();
  const participants = array(row.members).map(profile);
  if (!participants.some(member => member.did === actor)) throw unavailable();
  const status = row.status === "request" || row.status === "accepted" ? row.status : undefined;
  const group = record(row.kind);
  const name = typeof group.name === "string" && group.name.trim() ? group.name : undefined;
  const lock = group.lockStatus;
  return {
    id, participants, name, status,
    locked: lock === "locked" || lock === "locked-permanently",
    lastMessage: row.lastMessage ? message(row.lastMessage) : undefined,
  };
}

export function createBlueskyChat({
  sign, fetcher = fetch,
}: {
  sign: (actor: string, method: string, audience: string) => Promise<string>;
  fetcher?: typeof fetch;
}) {
  async function call(
    actor: string, method: typeof METHODS[keyof typeof METHODS], params?: URLSearchParams, body?: object,
  ) {
    const url = new URL(`/xrpc/${method}`, CHAT_ORIGIN);
    if (params) url.search = params.toString();
    const token = await sign(actor, method, CHAT_AUDIENCE);
    const isSend = method === METHODS.send;
    let res: Response;
    try {
      res = await fetcher(url, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch {
      throw isSend ? sendUncertain() : unavailable();
    }
    const payload: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const error = record(payload).error;
      throw providerFailure(res.status, typeof error === "string" ? error : undefined, isSend);
    }
    return record(payload);
  }

  return {
    async list(actor: string, cursor?: string) {
      const params = new URLSearchParams({ limit: PAGE_SIZE });
      if (cursor) params.set("cursor", cursor);
      const result = await call(actor, METHODS.list, params);
      return {
        conversations: array(result.convos).map(row => conversation(row, actor)),
        next: pageCursor(result.cursor, cursor),
      };
    },
    async messages(actor: string, id: string, cursor?: string) {
      const params = new URLSearchParams({ convoId: id, limit: PAGE_SIZE });
      if (cursor) params.set("cursor", cursor);
      const result = await call(actor, METHODS.messages, params);
      return {
        messages: array(result.messages).map(message),
        profiles: result.relatedProfiles ? array(result.relatedProfiles).map(profile) : [],
        next: pageCursor(result.cursor, cursor),
      };
    },
    async open(actor: string, handle: string) {
      const profileUrl = new URL("/xrpc/app.bsky.actor.getProfile", PROFILE_ORIGIN);
      profileUrl.searchParams.set("actor", handle);
      const res = await fetcher(profileUrl, {
        redirect: "error", signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      }).catch(() => { throw unavailable(); });
      if (res.status === 400 || res.status === 404) throw providerFailure(400, "RecipientNotFound", false);
      if (!res.ok) throw providerFailure(res.status, undefined, false);
      const recipient = profile(await res.json().catch(() => undefined));
      if (recipient.handle.toLowerCase() !== handle) throw providerFailure(400, "RecipientNotFound", false);
      if (recipient.did === actor) {
        throw new ChatFailure(400, "invalid_input", "Enter a Bluesky handle other than this site's.");
      }
      const result = await call(actor, METHODS.open, new URLSearchParams({ members: recipient.did }));
      const opened = conversation(result.convo, actor);
      if (!opened.participants.some(member => member.did === recipient.did)) throw unavailable();
      return opened;
    },
    async send(actor: string, id: string, text: string) {
      const result = await call(actor, METHODS.send, undefined, { convoId: id, message: { text } });
      try {
        const sent = message(result);
        if (sent.kind !== "text" || sent.senderDid !== actor) throw sendUncertain();
        return sent;
      } catch {
        throw sendUncertain();
      }
    },
  };
}

export type BlueskyChat = ReturnType<typeof createBlueskyChat>;
