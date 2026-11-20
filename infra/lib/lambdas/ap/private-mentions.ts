import { createHash } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  FEDIVERSE_MESSAGE_LIMIT, type FediverseMessage, type FediverseMessageInput, type FediverseMessageCommand,
} from "../../../fediverse-messages";
import { parseAcct, resolveActorByAcct, type FetchJson } from "./following";
import { safeHttpsUrl, sanitizeHtml, sanitizePlainText } from "./sanitize";
import type { signRequest } from "./httpsig";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messageId = /^(?:in-[0-9a-f]{64}|out-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const datePattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
const leaseMs = 45_000;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ownId = (actor: PrivateMentionActor) => `${actor.origin}/ap/users/${actor.handle}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const htmlMaxBytes = 16_000;

export type PrivateMentionActor = { did: string; handle: string; origin: string };

export type MentionRow = Omit<FediverseMessage, "status"> & {
  status: FediverseMessage["status"] | "withdrawn";
  objectId: string;
  peerId: string;
  peerInbox?: string;
  replyId?: string;
  fingerprint?: string;
  leaseUntil?: number;
  version: number;
  revisionAt?: string;
};

export interface PrivateMentionStore {
  get(did: string, id: string): Promise<MentionRow | undefined>;
  create(did: string, row: MentionRow): Promise<boolean>;
  replace(did: string, row: MentionRow): Promise<boolean>;
  list(did: string, cursor?: string): Promise<{ messages: MentionRow[]; cursor?: string }>;
}

export type PrivateMentionPorts = {
  store: PrivateMentionStore;
  authenticate(authorization: string | undefined, host: string | undefined, origin: string | undefined): Promise<PrivateMentionActor | undefined>;
  fetchJson: FetchJson;
  fetchActorJson: FetchJsonForActor;
  signRequest: typeof signRequest;
  getApKey(handle: string): Promise<{ privatePem: string }>;
  deliver(inbox: string, body: Buffer, headers: Record<string, string>): Promise<void | { status: number }>;
};

type FetchJsonForActor = (url: string, from: PrivateMentionActor) => Promise<unknown>;

export class PrivateMentionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const privateMessageKey = (row: Pick<MentionRow, "id" | "sentAt">) => `MSG#${row.sentAt}#${row.id}`;

export function validPrivateMessageCursor(cursor: string): boolean {
  const [kind, date, id, extra] = cursor.split("#");
  return kind === "MSG" && date?.length === 24 && datePattern.test(date) && !!id && messageId.test(id) && extra === undefined;
}

export function privateMessageView(row: MentionRow): FediverseMessage | undefined {
  const { id, direction, peer, text, sentAt, status } = row;
  if (status === "withdrawn") return;
  return { id, direction, peer, text, sentAt, status: status === "sending" && (row.leaseUntil ?? 0) <= Date.now() ? "uncertain" : status };
}

const urlsId = (v: unknown) => typeof v === "string" ? v
  : v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : undefined;

function addressedToOnly(activity: Record<string, unknown>, object: Record<string, unknown>, recipient: string): boolean {
  const fields = ["to", "cc", "audience"];
  const recipients = (item: Record<string, unknown>, keys: string[]) => keys.flatMap(key => {
    const value = item[key];
    return Array.isArray(value) ? value : value == null ? [] : [value];
  });
  if ([activity, object].some(item => recipients(item, ["bto", "bcc"]).length)) return false;
  const address = [...recipients(activity, fields), ...recipients(object, fields)];
  return address.length > 0 && address.every(value => urlsId(value) === recipient);
}

function sameAuthority(id: string, signer: string) {
  return safeHttpsUrl(id) === id && safeHttpsUrl(signer) === signer && new URL(id).origin === new URL(signer).origin;
}

function validDate(input: unknown): string | undefined {
  const time = typeof input === "string" && /^\d{4}-\d{2}-\d{2}T/.test(input) ? Date.parse(input) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function plainPrivateMention(content: unknown, contentWarning?: unknown): string {
  if (typeof content !== "string" || Buffer.byteLength(content) > htmlMaxBytes) return "";
  const extract = (input: unknown) => {
    const node = parseFragment(sanitizeHtml(input));
    function textOf(current: DefaultTreeAdapterMap["childNode"]): string {
      if (current.nodeName === "#text" && "value" in current) return current.value;
      if (!("childNodes" in current)) return "";
      if ("tagName" in current && current.tagName === "br") return "\n";
      const text = current.childNodes.map(textOf).join("");
      return "tagName" in current && current.tagName === "p" ? `${text}\n\n` : text;
    }
    return node.childNodes.map(textOf).join("").trim();
  };
  const text = [extract(typeof contentWarning === "string" ? contentWarning.slice(0, 500) : undefined), extract(content)]
    .filter(Boolean).join("\n\n");
  return sanitizePlainText(text, 8_000)?.trim() ?? "";
}

function peerLabel(actorId: string): string {
  const url = new URL(actorId);
  const name = /^\/(?:users\/|@)([A-Za-z0-9._-]{1,64})\/?$/.exec(url.pathname)?.[1]
    ?? /^\/ap\/users\/([A-Za-z0-9_-]{1,64})\./.exec(url.pathname)?.[1];
  return name ? `@${name}@${url.hostname}` : actorId;
}

/** Return true when this embedded Note belongs only to the private inbox. */
export async function ingestPrivateMention(
  activity: Record<string, unknown>, actor: PrivateMentionActor, signer: string, store: PrivateMentionStore,
): Promise<boolean> {
  const { type, object } = activity;
  if (type !== "Create" && type !== "Update" && type !== "Delete") return false;
  const id = urlsId(object);
  if (!id || !sameAuthority(id, signer) || id === signer) return false;
  const messageKey = `in-${digest(`${signer}\n${id}`)}`;
  const local = ownId(actor);
  const note = object && typeof object === "object" && !Array.isArray(object) ? object as Record<string, unknown> : undefined;
  const direct = addressedToOnly(activity, note ?? {}, local);
  const privateAudience = direct || addressedToOnly(activity, {}, local) || addressedToOnly({}, note ?? {}, local);
  if (type === "Create") {
    if (!direct) return privateAudience;
    if (note?.type !== "Note" || urlsId(note.attributedTo) !== signer) return true;
    const text = plainPrivateMention(note.content, note.summary);
    if (!text) return true;
    const now = new Date().toISOString();
    await store.create(actor.did, {
      id: messageKey, direction: "received", peer: peerLabel(signer), peerId: signer,
      text, sentAt: now, objectId: id, status: "received", version: 1,
      revisionAt: validDate(note.updated) ?? validDate(note.published) ?? now,
    });
    return true;
  }

  const previous = await store.get(actor.did, messageKey);
  if (!previous || previous.status === "withdrawn") return privateAudience;
  if (type === "Delete") {
    if (!await store.replace(actor.did, { ...previous, text: "", status: "withdrawn", version: previous.version + 1 })) {
      throw new Error("Private mention changed during delete");
    }
    return true;
  }
  if (note?.type !== "Note" || urlsId(note.attributedTo) !== signer) return privateAudience;
  const revisionAt = validDate(note.updated);
  if (revisionAt && previous.revisionAt && revisionAt <= previous.revisionAt) return true;
  const text = direct ? plainPrivateMention(note.content, note.summary) : "";
  if (!await store.replace(actor.did, {
    ...previous, text, status: text ? "received" : "withdrawn",
    revisionAt: revisionAt ?? new Date().toISOString(), version: previous.version + 1,
  })) throw new Error("Private mention changed during update");
  return true;
}

function safeText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 8_000) return;
  const text = sanitizePlainText(raw.replace(/\r\n?/g, "\n"), 8_000)?.trim();
  if (!text || Array.from(segmenter.segment(text)).length > FEDIVERSE_MESSAGE_LIMIT) return;
  return text;
}

export function parsePrivateMention(input: unknown): FediverseMessageCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PrivateMentionError(400, "Use a valid message request.");
  if ("retry" in input && Object.keys(input).length === 1 && typeof input.retry === "string"
    && input.retry.startsWith("out-") && messageId.test(input.retry)) return { retry: input.retry };
  const { text: raw, requestId, recipient, replyTo, ...extra } = input as Record<string, unknown>;
  if (Object.keys(extra).length || typeof requestId !== "string" || !uuid.test(requestId)) {
    throw new PrivateMentionError(400, "Use a valid message request.");
  }
  const text = safeText(raw);
  if (!text) throw new PrivateMentionError(400, `Write between 1 and ${FEDIVERSE_MESSAGE_LIMIT} characters.`);
  if (typeof replyTo === "string" && messageId.test(replyTo) && recipient === undefined) return { text, requestId, replyTo };
  const acct = parseAcct(recipient);
  if (!acct || replyTo !== undefined) throw new PrivateMentionError(400, "Enter a Fediverse address such as @name@mastodon.social.");
  return { recipient: `@${acct.user}@${acct.domain}`, text, requestId };
}

const escape = (value: string) => value.replace(/[&<>"']/g, ch => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
));

/** Create + embedded Note addressed to one actor. The object stays out of public GET and outbox. */
export function buildPrivateMention(row: MentionRow, sender: string) {
  const to = [row.peerId];
  const mention = `<span class="h-card"><a href="${escape(row.peerId)}" class="u-url mention">${escape(row.peer)}</a></span>`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${row.objectId}/activity`, actor: sender, type: "Create", to,
    object: {
      id: row.objectId, type: "Note", attributedTo: sender, to, cc: [],
      published: row.sentAt,
      ...(row.replyId ? { inReplyTo: row.replyId } : {}),
      content: `<p>${mention} ${escape(row.text).replace(/\n/g, "<br>")}</p>`,
      tag: [{ type: "Mention", href: row.peerId, name: row.peer }],
    },
  };
}

async function resolvePeer(ports: PrivateMentionPorts, actor: PrivateMentionActor, input: FediverseMessageInput) {
  try {
    if (input.recipient) {
      const target = await resolveActorByAcct(parseAcct(input.recipient)!, ports.fetchJson, [],
        url => ports.fetchActorJson(url, actor));
      if (target.actorId === ownId(actor)) throw new Error();
      return { peer: `@${target.acct}`, peerId: target.actorId, peerInbox: target.inbox };
    }
    const parent = await ports.store.get(actor.did, input.replyTo!);
    if (!parent || (parent.status !== "received" && parent.status !== "accepted")) throw new Error();
    const doc = await ports.fetchActorJson(parent.peerId, actor) as { id?: unknown; preferredUsername?: unknown; inbox?: unknown } | null;
    const inbox = safeHttpsUrl(doc?.inbox);
    const acct = typeof doc?.preferredUsername === "string"
      ? parseAcct(`${doc.preferredUsername}@${new URL(parent.peerId).hostname}`) : null;
    if (doc?.id !== parent.peerId || !inbox || !acct) throw new Error();
    return { peer: `@${acct.user}@${acct.domain}`, peerId: parent.peerId, peerInbox: inbox, replyId: parent.objectId };
  } catch {
    throw new PrivateMentionError(422, "Could not verify a recipient inbox for this message.");
  }
}

export async function sendPrivateMention(actor: PrivateMentionActor, input: FediverseMessageCommand, ports: PrivateMentionPorts) {
  const id = "retry" in input ? input.retry : `out-${input.requestId}`;
  const now = Date.now();
  const existing = await ports.store.get(actor.did, id);
  const fingerprint = "retry" in input ? existing?.fingerprint : digest(JSON.stringify([input.recipient, input.replyTo, input.text]));
  if (existing && existing.fingerprint !== fingerprint) {
    throw new PrivateMentionError(409, "This send request already belongs to another message.");
  }
  if (existing?.status === "accepted" || existing?.status === "rejected"
    || (existing?.status === "sending" && (existing.leaseUntil ?? 0) > now)) return privateMessageView(existing);

  const sender = ownId(actor);
  let row: MentionRow;
  if (existing) {
    row = { ...existing, status: "sending", leaseUntil: now + leaseMs, version: existing.version + 1 };
  } else {
    if ("retry" in input) throw new PrivateMentionError(422, "That message is unavailable.");
    row = {
      ...await resolvePeer(ports, actor, input),
      id, fingerprint, text: input.text, direction: "sent", sentAt: new Date().toISOString(),
      objectId: `${sender}/private-mentions/${input.requestId}`, status: "sending", leaseUntil: Date.now() + leaseMs, version: 1,
    };
  }
  const claimed = existing ? await ports.store.replace(actor.did, row) : await ports.store.create(actor.did, row);
  if (!claimed) {
    const current = await ports.store.get(actor.did, id);
    if (!current || current.fingerprint !== fingerprint) throw new PrivateMentionError(409, "This send request already belongs to another message.");
    return privateMessageView(current);
  }
  let status: MentionRow["status"] = "uncertain";
  try {
    const body = Buffer.from(JSON.stringify(buildPrivateMention(row, sender)));
    const { privatePem } = await ports.getApKey(actor.handle);
    const url = row.peerInbox!;
    const signed = await ports.signRequest({ method: "POST", url, keyId: `${sender}#main-key`, privateKeyPem: privatePem, body });
    const result = await ports.deliver(url, body, signed);
    const code = result?.status ?? 202;
    if (code >= 200 && code < 300) status = "accepted";
    else if (code >= 400 && code < 500 && code !== 408 && code !== 429) status = "rejected";
  } catch {
    // A lost response may mean the remote accepted the request. Retry with the same object id.
  }
  const done = { ...row, status, leaseUntil: undefined, version: row.version + 1 };
  if (!await ports.store.replace(actor.did, done)) throw new PrivateMentionError(503, "Send status could not be confirmed. Retry the same message.");
  return privateMessageView(done);
}
