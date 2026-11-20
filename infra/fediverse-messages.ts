export const FEDIVERSE_MESSAGES_PATH = "/auth/fediverse-messages";
export const FEDIVERSE_MESSAGE_LIMIT = 500;

export type FediverseMessage = {
  id: string;
  direction: "received" | "sent";
  peer: string;
  text: string;
  sentAt: string;
  status: "received" | "sending" | "accepted" | "uncertain" | "rejected";
};

export type FediverseMessagePage = {
  actor: { handle: string; acct: string };
  messages: FediverseMessage[];
  cursor?: string;
};

export type FediverseMessageInput = { text: string; requestId: string }
  & ({ recipient: string; replyTo?: never } | { recipient?: never; replyTo: string });
export type FediverseMessageCommand = FediverseMessageInput | { retry: string };

export class FediverseMessagesError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FediverseMessagesError";
  }
}

type TokenGetter = () => string | null | undefined | Promise<string | null | undefined>;

export function createFediverseMessagesClient(token: TokenGetter, baseUrl?: string) {
  async function request<T>(input: { cursor?: string; body?: object; signal?: AbortSignal }): Promise<T> {
    const session = await token();
    if (!session) throw new FediverseMessagesError(401, "Sign in to open Fediverse messages.");
    const query = input.cursor ? `?${new URLSearchParams({ cursor: input.cursor })}` : "";
    const path = FEDIVERSE_MESSAGES_PATH + query;
    const url = baseUrl ? new URL(path, baseUrl) : path;
    if (url instanceof URL && typeof window !== "undefined" && url.origin !== window.location.origin) {
      throw new FediverseMessagesError(403, "Open messages from the site you signed in to.");
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: input.body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${session}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new FediverseMessagesError(503, input.body
        ? "Send status could not be confirmed. Retry the same message."
        : "Could not open your Fediverse messages.");
    }
    const data = response.headers.get("content-type")?.includes("application/json")
      ? await response.json().catch(() => undefined) : undefined;
    if (!response.ok || !data || typeof data !== "object") {
      throw new FediverseMessagesError(response.status, data?.message ?? "Fediverse messages are unavailable.");
    }
    return data as T;
  }

  return {
    list: (cursor?: string, signal?: AbortSignal) => request<FediverseMessagePage>({ cursor, signal }),
    send: (body: FediverseMessageCommand, signal?: AbortSignal) => request<{ message: FediverseMessage }>({ body, signal }),
  };
}

export type FediverseMessagesClient = ReturnType<typeof createFediverseMessagesClient>;
