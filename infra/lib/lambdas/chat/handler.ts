import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { isValidHandle } from "@atproto/syntax";
import {
  MESSAGE_MAX_GRAPHEMES, MESSAGES_PATH, messageTooLong, type ChatProfile, type MessageErrorCode,
} from "../../../direct-messages";
import { resolveApprovedDids } from "../auth/entitlements";
import { verifyJwt } from "../auth/lib/jwt";
import { publishingHost, sharingHosts } from "../auth/site-sharing";
import { serviceAuthJwt } from "../pds/appview-proxy";
import { tenantKeyRef } from "../pds/keymgmt";
import { getSigningKey } from "../pds/signing-key";
import { ChatFailure, createBlueskyChat, validChatCursor, validConversationId, type BlueskyChat } from "./bluesky";

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const conversationsPath = `${MESSAGES_PATH}/conversations`;

type Session = { email: string; siteHost?: string };
type SiteActor = ChatProfile & { signingKeyRef: string };
type HandlerDeps = {
  verify: (token: string) => Promise<Session>;
  hosts: ReadonlySet<string>;
  actorFor: (email: string, host: string) => Promise<SiteActor | undefined>;
  chatFor: (actor: SiteActor) => BlueskyChat;
};

function json(statusCode: number, value: object) {
  return { statusCode, headers: responseHeaders, body: JSON.stringify(value) };
}

function failure(status: number, code: MessageErrorCode, message: string) {
  return json(status, { code, message });
}

const invalid = (message: string) => failure(400, "invalid_input", message);

function postValue(event: APIGatewayProxyEventV2, key: string): string | undefined {
  if (!event.body || event.body.length > 16_000 || event.isBase64Encoded) return;
  try {
    const body: unknown = JSON.parse(event.body);
    if (!body || typeof body !== "object" || Object.keys(body).length !== 1) return;
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  } catch {
    return;
  }
  return undefined;
}

export function createDirectMessageHandler(deps: HandlerDeps) {
  return async (event: APIGatewayProxyEventV2) => {
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const bearer = /^Bearer ([^\s,]+)$/i.exec(headers.authorization ?? "");
    if (!bearer) return failure(401, "sign_in", "Sign in to open your messages.");
    const session = await deps.verify(bearer[1]).catch(() => undefined);
    if (!session) return failure(401, "sign_in", "Sign in again to open your messages.");
    const host = headers["x-pds-viewer-host"];
    if (!host || !deps.hosts.has(host) || session.siteHost !== host ||
        (headers.origin && headers.origin !== `https://${host}`)) {
      return failure(403, "site_session_required", "Sign in on this site to open its messages.");
    }

    const query = event.queryStringParameters ?? {};
    if (Object.keys(query).some(key => key !== "cursor") ||
        (query.cursor !== undefined && !validChatCursor(query.cursor))) {
      return invalid("Invalid messages page.");
    }
    const httpMethod = event.requestContext.http.method;
    const path = event.rawPath;
    const isSend = httpMethod === "POST" && path.startsWith(`${conversationsPath}/`);
    try {
      const actor = await deps.actorFor(session.email, host);
      if (!actor) {
        return failure(403, "site_identity_required", "This sign-in can’t access the site's Bluesky messages.");
      }
      const chat = deps.chatFor(actor);
      if (path === MESSAGES_PATH && httpMethod === "GET") {
        return json(200, { actor: { did: actor.did, handle: actor.handle }, ...await chat.list(actor.did, query.cursor) });
      }
      if (path === conversationsPath && httpMethod === "POST") {
        const handle = postValue(event, "handle")?.trim().replace(/^@/, "").toLowerCase();
        if (!handle || !isValidHandle(handle)) return invalid("Enter a valid Bluesky handle, such as @someone.bsky.social.");
        return json(200, { conversation: await chat.open(actor.did, handle) });
      }
      if (path.startsWith(`${conversationsPath}/`)) {
        const id = event.pathParameters?.conversationId;
        if (!validConversationId(id)) return invalid("Invalid conversation.");
        if (httpMethod === "GET") return json(200, await chat.messages(actor.did, id, query.cursor));
        if (httpMethod === "POST") {
          const message = postValue(event, "text");
          if (!message?.trim()) return invalid("Write a message before sending.");
          if (messageTooLong(message)) return invalid(`Use up to ${MESSAGE_MAX_GRAPHEMES.toLocaleString("en-US")} characters per message.`);
          return json(200, { message: await chat.send(actor.did, id, message) });
        }
      }
      return invalid("Invalid messages request.");
    } catch (error) {
      if (error instanceof ChatFailure) return failure(error.status, error.code, error.message);
      // AWS and upstream exceptions may contain private request details.
      return isSend
        ? failure(503, "send_uncertain", "Delivery could not be confirmed. Refresh the conversation before trying again.")
        : failure(503, "chat_unavailable", "Could not load your Bluesky messages. Try again shortly.");
    }
  };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const domain = process.env.DOMAIN!;
const apexHandle = process.env.PDS_HANDLE ?? domain;
const apexDid = `did:web:${apexHandle}`;
const tenantsTable = process.env.TENANTS_TABLE!;
const allowedEmails = (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || "").split(",")
  .map(email => email.trim()).filter(Boolean);
const hosts = sharingHosts(domain, process.env.KNOWN_TENANT_HOSTS);

export const handler = createDirectMessageHandler({
  verify: verifyJwt,
  hosts,
  async actorFor(email, host): Promise<SiteActor | undefined> {
    const approved = await resolveApprovedDids(email, { ddb, apexDid, apexHandle, tenantsTable, allowedEmails });
    const matches = approved.filter(actor => publishingHost(actor, { ddb, apexDid, domain, hosts }) === host);
    if (matches.length !== 1) return;
    const { did, handle } = matches[0];
    if (did === apexDid) {
      const signingKeyRef = process.env.SIGNING_KEY_PARAM;
      return signingKeyRef ? { did, handle, signingKeyRef } : undefined;
    }

    // A GSI can still return an old owner after a transfer or suspension.
    const { Item } = await ddb.send(new GetCommand({ TableName: tenantsTable, Key: { did }, ConsistentRead: true }));
    const signingKeyRef = tenantKeyRef(did, "signing");
    if (Item?.status === "active" && Item.email === email && Item.handle === handle && Item.signingKeyRef === signingKeyRef) {
      return { did, handle, signingKeyRef };
    }
    return undefined;
  },
  chatFor(actor) {
    return createBlueskyChat({
      sign: async (did, method, audience) => {
        if (did !== actor.did) throw new Error("Mismatched chat signing identity");
        const key = await getSigningKey(actor.signingKeyRef);
        return serviceAuthJwt(key, method, audience, did);
      },
    });
  },
});
