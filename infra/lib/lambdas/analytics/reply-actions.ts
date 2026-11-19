import { createHash } from "node:crypto";
import { TID } from "@atproto/common-web";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { ArticleReply, InsightSite, ReplyNetwork, ReplySubmission } from "../../../insights";
import { mintFirstPartySessionFor } from "../auth/session-mint";
import type { ResolveDeps } from "../auth/entitlements";
import { loadAppJwtKey } from "../auth/lib/jwt";
import {
  blueskyOnlyPartition, incomingArticleReplyKey, isCurrentArticleReply, replyContentDigest, replyRequestId, validReplyText,
} from "../ap/article-replies";
import type { InboundRecord } from "../ap/ingest";
import { safeHttpsUrl } from "../ap/sanitize";
import type { IndexItem } from "../pds/longform-index";

const collection = "app.bsky.feed.post";
const appView = "https://public.api.bsky.app";
const bskyUri = /^at:\/\/(did:[a-z]+:[a-z0-9.:%-]+)\/app\.bsky\.feed\.post\/([a-z0-9._~:-]+)$/i;
const strongCid = /^b[a-z2-7]{20,120}$/;

export function blueskyLink(uri: string) {
  const match = bskyUri.exec(uri);
  return match ? `https://bsky.app/profile/${encodeURIComponent(match[1])}/post/${encodeURIComponent(match[2])}` : undefined;
}

type ReplyTarget = Pick<ArticleReply, "id" | "network">;
type TeamContext = { entitlements: ResolveDeps; analyticsTable: string; inboundTable: string; apiOrigin: string };
type Ref = { uri: string; cid: string };
type BlueRecord = { $type: string; text: string; createdAt: string; reply: { root: Ref; parent: Ref } };
type BlueIntent = { fingerprint: string; rkey: string; record: BlueRecord };
type ReplyIntent = { action: "send"; requestId: string; text: string } | { action: "handled"; handled: boolean };

export class ReplyActionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function unavailable(): never {
  throw new ReplyActionError(422, "That reply is unavailable for this article.");
}

function isConflict(error: unknown) {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export function readReplyAction(input: unknown): ReplyIntent & ReplyTarget {
  if (!input || typeof input !== "object") throw new ReplyActionError(400, "Enter a valid reply action.");
  const data = input as Record<string, unknown>;
  const { action, network, id, text, requestId, handled } = data;
  if ((network !== "Bluesky" && network !== "Fediverse") || typeof id !== "string" || id.length > 2048 ||
      (network === "Bluesky" ? !bskyUri.test(id) : !safeHttpsUrl(id))) {
    throw new ReplyActionError(400, "Choose a valid reply.");
  }
  if (action === "handled" && typeof handled === "boolean") return { action, network, id, handled };
  if (action === "send" && typeof requestId === "string" && replyRequestId.test(requestId) && validReplyText(text)) {
    return { action, network, id, requestId, text: text.trim() };
  }
  throw new ReplyActionError(400, "Enter a reply of up to 300 characters or choose a valid inbox action.");
}

function replyStateKey(did: string, rkey: string, target: ReplyTarget) {
  const suffix = createHash("sha256").update(JSON.stringify([target.network, target.id])).digest("hex");
  return { pk: `REPLY_STATE#${did}`, sk: `${rkey}#${suffix}` };
}

export async function readHandled(context: TeamContext, did: string, rkey: string, replies: ArticleReply[]) {
  if (!replies.length) return replies;
  const table = context.analyticsTable;
  const keys = new Map(replies.map(reply => {
    const key = replyStateKey(did, rkey, reply);
    return [key.sk, key];
  }));
  const uniqueKeys = [...keys.values()];
  const handled = new Set<string>();
  for (let offset = 0; offset < uniqueKeys.length; offset += 100) {
    let request = { [table]: { Keys: uniqueKeys.slice(offset, offset + 100), ConsistentRead: true } };
    for (let attempt = 0; ; attempt++) {
      const result = await context.entitlements.ddb.send(new BatchGetCommand({ RequestItems: request }));
      for (const item of result.Responses?.[table] ?? []) handled.add(item.sk);
      const pending = result.UnprocessedKeys?.[table]?.Keys;
      if (!pending?.length) break;
      if (attempt >= 2) throw new ReplyActionError(503, "Couldn't load the inbox status. Try again shortly.");
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
      request = { [table]: { Keys: pending as typeof uniqueKeys, ConsistentRead: true } };
    }
  }
  return replies.map(reply => ({ ...reply, handled: handled.has(replyStateKey(did, rkey, reply).sk) }));
}

async function readBlueskyParent(site: InsightSite, item: IndexItem, id: string) {
  const root = item.syndication?.bsky;
  if (!root || !root.uri.startsWith(`at://${site.did}/${collection}/`) || !bskyUri.test(root.uri) ||
      !strongCid.test(root.cid) || id === root.uri || id.startsWith(`at://${site.did}/`)) unavailable();
  const url = new URL("/xrpc/app.bsky.feed.getPosts", appView);
  url.searchParams.set("uris", id);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new ReplyActionError(503, "Bluesky is unavailable. Try again shortly.");
  const { posts } = await response.json() as { posts?: { uri: string; cid: string; record?: { reply?: { root?: Ref } } }[] };
  const parent = posts?.find(post => post.uri === id);
  if (!parent || !strongCid.test(parent.cid) || parent.record?.reply?.root?.uri !== root.uri) unavailable();
  return { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid } };
}

async function readFediverseParent(context: TeamContext, site: InsightSite, item: IndexItem, id: string) {
  const row = await context.entitlements.ddb.send(new GetCommand({
    TableName: context.inboundTable, Key: incomingArticleReplyKey(site.handle, id), ConsistentRead: true,
  }));
  if (!isCurrentArticleReply(row.Item as InboundRecord | undefined, item.rkey, id)) unavailable();
}

async function reserveBlueskyReply(context: TeamContext, site: InsightSite, item: IndexItem, id: string, requestId: string, text: string) {
  const { analyticsTable, entitlements: { ddb } } = context;
  const key = { pk: `REPLY_SEND#${site.did}`, sk: requestId };
  const fingerprint = replyContentDigest("Bluesky", item.rkey, id, text);
  const read = async () => (await ddb.send(new GetCommand({ TableName: analyticsTable, Key: key, ConsistentRead: true }))).Item as BlueIntent | undefined;
  let intent = await read();
  if (!intent) {
    const reply = await readBlueskyParent(site, item, id);
    const proposed: BlueIntent = {
      fingerprint, rkey: TID.nextStr(),
      record: { $type: collection, text, createdAt: new Date().toISOString(), reply },
    };
    try {
      await ddb.send(new PutCommand({
        TableName: analyticsTable, Item: { ...key, ...proposed }, ConditionExpression: "attribute_not_exists(sk)",
      }));
      intent = proposed;
    } catch (error) {
      if (!isConflict(error)) throw error;
      intent = await read();
    }
  }
  if (intent?.fingerprint !== fingerprint) {
    throw new ReplyActionError(409, "This reply request has already been used.");
  }
  return intent;
}

async function appRequest(context: TeamContext, path: string, token: string, body?: object, timeout = 8_000) {
  return fetch(new URL(path, context.apiOrigin), {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(timeout),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function postBluesky(context: TeamContext, site: InsightSite, token: string, intent: BlueIntent): Promise<ReplySubmission> {
  const { rkey, record } = intent;
  const uri = `at://${site.did}/${collection}/${rkey}`;
  // Write the protocol selection before the repo record. The ActivityPub stream
  // can see that record as soon as the PDS commits it.
  await context.entitlements.ddb.send(new PutCommand({
    TableName: context.inboundTable, Item: { pk: blueskyOnlyPartition(site.did), sk: rkey },
  }));
  let written = false;
  try {
    const response = await appRequest(context, "/xrpc/com.atproto.repo.putRecord", token, {
      repo: site.did, collection, rkey, swapRecord: null, record,
    });
    written = response.ok && (await response.json() as { uri?: string }).uri === uri;
  } catch {
    // The PDS may have committed before the response was lost.
  }
  if (!written) {
    const query = new URLSearchParams({ repo: site.did, collection, rkey });
    const response = await appRequest(context, `/xrpc/com.atproto.repo.getRecord?${query}`, token);
    if (!response.ok) throw new ReplyActionError(503, "Couldn't verify the Bluesky reply. Retry to check the same submission.");
    const existing = await response.json() as { uri?: string; value?: BlueRecord };
    const value = existing.value;
    if (!value || existing.uri !== uri || value.$type !== collection || value.text !== record.text ||
        value.createdAt !== record.createdAt || value.reply?.root?.uri !== record.reply.root.uri ||
        value.reply.root.cid !== record.reply.root.cid || value.reply.parent?.uri !== record.reply.parent.uri ||
        value.reply.parent.cid !== record.reply.parent.cid) {
      throw new ReplyActionError(409, "This reply key is already in use.");
    }
  }
  return { status: "sent", url: blueskyLink(uri)! };
}

async function postFediverse(context: TeamContext, site: InsightSite, item: IndexItem, token: string, action: ReplyTarget & { requestId: string; text: string }): Promise<ReplySubmission> {
  const response = await appRequest(context, `/ap/users/${encodeURIComponent(site.handle)}/replies`, token, {
    articleRkey: item.rkey, parentId: action.id, text: action.text, requestId: action.requestId,
  }, 18_000);
  if (response.status === 409 || response.status === 422) {
    const result = await response.json() as { message?: string };
    throw new ReplyActionError(response.status, result.message ?? "The Fediverse reply could not be sent.");
  }
  if (!response.ok) throw new ReplyActionError(503, "Couldn't send the Fediverse reply. Try again shortly.");
  const result = await response.json() as ReplySubmission;
  if (!safeHttpsUrl(result.url) || (result.status !== "sent" && result.status !== "queued")) {
    throw new ReplyActionError(503, "Couldn't verify the Fediverse reply. Retry to check the same submission.");
  }
  return result;
}

export async function applyReplyAction(context: TeamContext, email: string, site: InsightSite, item: IndexItem, action: ReplyIntent & ReplyTarget) {
  if (action.action === "handled") {
    if (action.network === "Bluesky") await readBlueskyParent(site, item, action.id);
    else await readFediverseParent(context, site, item, action.id);
    const key = replyStateKey(site.did, item.rkey, action);
    const TableName = context.analyticsTable;
    if (action.handled) await context.entitlements.ddb.send(new PutCommand({ TableName, Item: key }));
    else await context.entitlements.ddb.send(new DeleteCommand({ TableName, Key: key }));
    return { handled: action.handled };
  }

  const session = await mintFirstPartySessionFor(email, site.did, {
    ...context.entitlements, secret: await loadAppJwtKey(),
  });
  if (!session || session.did !== site.did) throw new ReplyActionError(403, "This publishing identity is unavailable.");
  if (action.network === "Fediverse") return postFediverse(context, site, item, session.accessJwt, action);
  const intent = await reserveBlueskyReply(context, site, item, action.id, action.requestId, action.text);
  return postBluesky(context, site, session.accessJwt, intent);
}
