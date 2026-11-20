/** Browser-safe contract for the private Bluesky Chat gateway. */
export const MESSAGES_PATH = "/auth/messages";
export const MESSAGE_MAX_GRAPHEMES = 1000;
const MESSAGE_MAX_BYTES = 10000;
const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function messageLength(text: string) {
  return segmenter ? Array.from(segmenter.segment(text)).length : Array.from(text).length;
}

export function messageTooLong(text: string) {
  return new TextEncoder().encode(text).length > MESSAGE_MAX_BYTES || messageLength(text) > MESSAGE_MAX_GRAPHEMES;
}

export type ChatProfile = { did: string; handle: string; displayName?: string };
export type DirectMessage =
  | { kind: "text"; id: string; senderDid: string; text: string; sentAt: string }
  | { kind: "deleted"; id: string; senderDid: string; sentAt: string }
  | { kind: "activity"; id: string; sentAt: string };
export type Conversation = {
  id: string;
  participants: ChatProfile[];
  name?: string;
  status?: "accepted" | "request";
  locked?: boolean;
  lastMessage?: DirectMessage;
};
export type ConversationPage = { actor: ChatProfile; conversations: Conversation[]; next?: string };
export type MessagePage = { messages: DirectMessage[]; profiles: ChatProfile[]; next?: string };
export type MessageErrorCode =
  | "sign_in" | "site_session_required" | "site_identity_required"
  | "invalid_input" | "recipient_unavailable" | "conversation_unavailable"
  | "chat_not_authorized" | "chat_unavailable" | "rate_limited" | "send_uncertain";

export class DirectMessagesError extends Error {
  constructor(readonly status: number, readonly code: MessageErrorCode, message: string) {
    super(message);
    this.name = "DirectMessagesError";
  }
}

type TokenGetter = () => string | null | undefined | Promise<string | null | undefined>;

export function createDirectMessagesClient(token: TokenGetter, baseUrl?: string) {
  async function request<T>(path = "", opts: {
    cursor?: string; body?: object; signal?: AbortSignal; sending?: boolean;
  } = {}): Promise<T> {
    const session = await token();
    if (!session) throw new DirectMessagesError(401, "sign_in", "Sign in to open your messages.");
    const query = opts.cursor ? `?${new URLSearchParams({ cursor: opts.cursor })}` : "";
    const pathWithQuery = `${MESSAGES_PATH}${path}${query}`;
    const url = baseUrl ? new URL(pathWithQuery, baseUrl) : pathWithQuery;
    if (url instanceof URL && typeof window !== "undefined" && url.origin !== window.location.origin) {
      throw new DirectMessagesError(403, "site_session_required", "Open messages from the site you signed in to.");
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${session}`,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: opts.signal,
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new DirectMessagesError(503, opts.sending ? "send_uncertain" : "chat_unavailable",
        opts.sending
          ? "Delivery could not be confirmed. Refresh the conversation before trying again."
          : "Could not reach your messages. Try again in a moment.");
    }
    const json = response.headers.get("content-type")?.includes("application/json")
      ? await response.json().catch(() => undefined)
      : undefined;
    if (response.ok && json && typeof json === "object") return json as T;
    if (json?.code && typeof json.message === "string") {
      throw new DirectMessagesError(response.status, json.code, json.message);
    }
    if (opts.sending) {
      throw new DirectMessagesError(response.status, "send_uncertain",
        "Delivery could not be confirmed. Refresh the conversation before trying again.");
    }
    throw new DirectMessagesError(response.status, "chat_unavailable",
      "Messages are unavailable on this deployment.");
  }

  return {
    list: (cursor?: string, signal?: AbortSignal) => request<ConversationPage>("", { cursor, signal }),
    messages: (id: string, cursor?: string, signal?: AbortSignal) =>
      request<MessagePage>(`/conversations/${encodeURIComponent(id)}`, { cursor, signal }),
    open: (handle: string, signal?: AbortSignal) =>
      request<{ conversation: Conversation }>("/conversations", { body: { handle }, signal }),
    send: (id: string, text: string) =>
      request<{ message: DirectMessage }>(`/conversations/${encodeURIComponent(id)}`, {
        body: { text }, sending: true,
      }),
  };
}

export type DirectMessagesClient = ReturnType<typeof createDirectMessagesClient>;
