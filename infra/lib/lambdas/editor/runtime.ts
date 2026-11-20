import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { resolveApprovedDids } from "../auth/entitlements";
import { sharingHosts } from "../auth/site-sharing";
import { mintFirstPartySessionFor } from "../auth/session-mint";
import { collectionFor, HttpError, mediaKey, type Draft, type RecordValue } from "./model";
import type { PostKind } from "../../../editor";

export const env = process.env;
export const domain = env.DOMAIN!;
export const table = env.DRAFTS_TABLE!;
export const bucket = env.DRAFT_MEDIA_BUCKET!;
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({});
const ssm = new SSMClient({});
const apexHandle = env.PDS_HANDLE ?? domain;
const entitlements = {
  ddb,
  apexHandle,
  apexDid: `did:web:${apexHandle}`,
  tenantsTable: env.TENANTS_TABLE!,
  allowedEmails: (env.ALLOWED_EMAILS ?? "").split(",").map(email => email.trim()).filter(Boolean),
};

export const approvedIdentities = (email: string) => resolveApprovedDids(email, entitlements);
export const sharing = {
  ddb, domain, apexDid: entitlements.apexDid, table: env.SITE_SHARING_TABLE,
  hosts: sharingHosts(domain, env.KNOWN_TENANT_HOSTS),
};

let secret: Uint8Array | undefined;
export async function publicationToken(email: string, did: string) {
  if (!secret) {
    const result = await ssm.send(new GetParameterCommand({ Name: env.JWT_SECRET_NAME, WithDecryption: true }));
    if (!result.Parameter?.Value) throw new Error("Editor signing secret missing");
    secret = new TextEncoder().encode(result.Parameter.Value);
  }
  const session = await mintFirstPartySessionFor(email, did, { ...entitlements, secret });
  if (!session) throw new HttpError(403, "The publishing identity is no longer approved.");
  return session.accessJwt;
}

export async function getDraft(did: string, id: string): Promise<Draft | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: table, Key: { did, id }, ConsistentRead: true }));
  return result.Item as Draft | undefined;
}

export async function saveDraft(draft: Draft, previous: number | undefined): Promise<Draft> {
  const next = { ...draft, updatedAt: new Date().toISOString(), version: (previous ?? 0) + 1 };
  await ddb.send(new PutCommand({
    TableName: table,
    Item: next,
    ...(previous === undefined
      ? { ConditionExpression: "attribute_not_exists(id)" }
      : { ConditionExpression: "version = :old", ExpressionAttributeValues: { ":old": previous } }),
  }));
  return next;
}

export async function getSharedDraft(token: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: table,
    IndexName: "byShareToken",
    KeyConditionExpression: "shareToken = :token",
    ExpressionAttributeValues: { ":token": token },
    Limit: 1,
  }));
  const key = res.Items?.[0];
  const draft = key && await getDraft(key.did, key.id);
  // A lagging GSI can still contain a revoked token. Check the base row.
  if (!draft || draft.shareToken !== token || draft.state === "published") {
    throw new HttpError(410, "This preview link is unavailable.");
  }
  return draft;
}

export async function previewUrls(draft: Draft, expiresIn: number) {
  return Object.fromEntries(await Promise.all(draft.fields.images.map(async ({ id }) => [
    id,
    await getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket, Key: mediaKey(draft, id), ResponseCacheControl: "private, no-store",
    }), { expiresIn }),
  ])));
}

export class PdsError extends Error {
  constructor(readonly status: number, readonly code?: string) { super("The PDS could not complete the request."); }
}

export async function xrpc<T>(method: string, options: {
  query?: Record<string, string>;
  body?: RecordValue | Uint8Array;
  token?: string;
  mime?: string;
} = {}): Promise<T> {
  const url = new URL(`/xrpc/${method}`, env.XRPC_ORIGIN);
  url.search = new URLSearchParams(options.query).toString();
  const response = await fetch(url, {
    method: options.body ? "POST" : "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": options.mime ?? "application/json" } : {}),
    },
    ...(options.body ? {
      body: options.body instanceof Uint8Array ? Buffer.from(options.body) : JSON.stringify(options.body),
    } : {}),
    signal: AbortSignal.timeout(12_000),
  });
  const json = await response.json() as T & { error?: string };
  if (!response.ok) throw new PdsError(response.status, json.error);
  return json;
}

export type PublishedRecord = { uri: string; cid: string; value: RecordValue };
export async function getRecord(did: string, kind: PostKind, rkey: string): Promise<PublishedRecord | undefined> {
  try {
    return await xrpc<PublishedRecord>("com.atproto.repo.getRecord", {
      query: { repo: did, collection: collectionFor(kind), rkey },
    });
  } catch (error) {
    if (error instanceof PdsError && ["RecordNotFound", "RepoNotFound"].includes(error.code ?? "")) return;
    throw error;
  }
}
