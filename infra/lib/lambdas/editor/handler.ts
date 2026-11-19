import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { verifyJwt } from "../auth/lib/jwt";
import { mdToSafeHtml } from "../pds/longform-render";
import { emptyDraftFields, type EditorDraft, type PostKind } from "../../../editor";
import {
  collectionFor, extractFields, HttpError, imageMime, keyPattern, markdownWithImages, mediaKey,
  requireEditable, scheduleTime, uuidPattern, validateFields, validatePublication, type Draft, type Job,
} from "./model";
import {
  approvedIdentities, authorize, bucket, ddb, domain, env, getDraft, getRecord, getSharedDraft, PdsError,
  previewUrls, s3, saveDraft, table, xrpc, type PublishedRecord,
} from "./runtime";

const scheduler = new SchedulerClient({});
const sqs = new SQSClient({});
const base = "/auth/editor";
const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
};

function json(statusCode: number, value?: unknown) {
  return {
    statusCode,
    headers: { ...privateHeaders, "content-type": "application/json" },
    body: value === undefined ? "" : JSON.stringify(value),
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

async function share(path: string[]): Promise<APIGatewayProxyStructuredResultV2> {
  const [, token, action, id] = path;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw new HttpError(410, "This preview link is unavailable.");
  const draft = await getSharedDraft(token);
  const link = `${base}/share/${token}`;
  if (action === "media" && path.length === 4 && draft.fields.images.some(image => image.id === id)) {
    const item = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: mediaKey(draft, id) }));
    return {
      statusCode: 200, headers: { ...privateHeaders, "content-type": draft.media[id] },
      isBase64Encoded: true, body: await item.Body?.transformToString("base64"),
    };
  }
  if (path.length !== 2) throw new HttpError(410, "This preview link is unavailable.");
  const urls = Object.fromEntries(draft.fields.images.map(image => [image.id, `${link}/media/${image.id}`]));
  const title = escapeHtml(draft.fields.title || "Post preview");
  const markdown = mdToSafeHtml(markdownWithImages(draft, urls));
  const content = draft.kind === "longform" ? markdown
    : `<p style="white-space:pre-wrap">${escapeHtml(draft.fields.content)}</p>${markdown}`;
  return {
    statusCode: 200,
    headers: {
      ...privateHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; img-src 'self' https://${domain}/xrpc/com.atproto.sync.getBlob; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
    body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{max-width:70ch;margin:4rem auto;padding:0 1.25rem;font:1.1rem/1.6 system-ui;color-scheme:light dark}img{max-width:100%}pre{overflow:auto}</style><main><p>Unlisted preview</p><h1>${title}</h1>${content}</main></html>`,
  };
}

async function view(draft: Draft, event: APIGatewayProxyEventV2): Promise<EditorDraft> {
  const host = event.headers["x-pds-viewer-host"] ?? domain;
  const hosts = [domain, ...(env.KNOWN_TENANT_HOSTS ?? "").split(",")];
  const origin = `https://${hosts.includes(host) ? host : domain}`;
  const { id, did, kind, version, state, fields, updatedAt, scheduledAt, shareToken, result, error } = draft;
  return {
    id, did, kind, version, state, fields, updatedAt, scheduledAt, result, error,
    sourceRkey: draft.source?.rkey,
    ...(shareToken ? { shareUrl: `${origin}${base}/share/${shareToken}` } : {}),
    ...(state !== "published" && fields.images.length ? { previews: await previewUrls(draft, 900) } : {}),
  };
}

async function removeSchedule(id: string | undefined) {
  if (!id) return;
  try {
    await scheduler.send(new DeleteScheduleCommand({ GroupName: env.SCHEDULE_GROUP, Name: id }));
  } catch (error) {
    if ((error as Error).name !== "ResourceNotFoundException") {
      console.warn("Schedule cleanup deferred", (error as Error).name);
    }
  }
}

async function queuePublication(draft: Draft, email: string, at?: string) {
  requireEditable(draft);
  validatePublication(draft);
  const job: Job = { did: draft.did, id: draft.id, jobId: randomUUID() };
  const date = at ?? new Date(Date.now() + 120_000).toISOString();
  // Create a durable delivery before committing the draft. Stale deliveries are ignored.
  await scheduler.send(new CreateScheduleCommand({
    Name: job.jobId, GroupName: env.SCHEDULE_GROUP, ScheduleExpression: `at(${date.slice(0, 19)})`,
    ScheduleExpressionTimezone: "UTC", FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    Target: {
      Arn: env.QUEUE_ARN!, RoleArn: env.SCHEDULE_ROLE!, Input: JSON.stringify(job),
      DeadLetterConfig: { Arn: env.DEAD_LETTER_ARN },
      RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 10 },
    },
  }));
  const next = await saveDraft({
    ...draft, state: at ? "scheduled" : "publishing", scheduledAt: at, error: undefined,
    job: { id: job.jobId, email }, attempt: draft.attempt,
  }, draft.version).catch(async error => {
    // On an unknown outcome the durable delivery is needed if the write committed.
    if ((error as Error).name === "ConditionalCheckFailedException") await removeSchedule(job.jobId);
    throw error;
  });
  await removeSchedule(draft.job?.id);
  if (!at) {
    try {
      await sqs.send(new SendMessageCommand({ QueueUrl: env.QUEUE_URL, MessageBody: JSON.stringify(job) }));
    } catch (error) {
      console.warn("Immediate delivery deferred to Scheduler", (error as Error).name);
    }
  }
  return next;
}

function readJson(event: APIGatewayProxyEventV2): unknown {
  try { return JSON.parse(event.body ?? "{}"); }
  catch { throw new HttpError(400, "Invalid JSON."); }
}

function validKind(value: unknown): PostKind {
  if (value === "post" || value === "longform") return value;
  throw new HttpError(400, "Choose a post or an article.");
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath.slice(base.length).split("/").filter(Boolean);
    if (path[0] === "share" && path.length > 1 && method === "GET") return await share(path);
    const bearer = /^Bearer (\S+)$/i.exec(event.headers.authorization ?? "");
    if (!bearer) throw new HttpError(401, "Sign in to use the editor.");
    const { email } = await verifyJwt(bearer[1]).catch(() => {
      throw new HttpError(401, "Sign in to use the editor.");
    });
    if (path.length === 1 && path[0] === "identities" && method === "GET") {
      const identities = await approvedIdentities(email);
      return json(200, { identities: identities.map(({ did, handle }) => ({ did, handle })) });
    }
    const query = event.queryStringParameters ?? {};
    const { did } = query;
    if (!did || !did.startsWith("did:") || did.length > 512) throw new HttpError(400, "Choose an identity.");
    await authorize(email, did);

    if (path[0] === "published" && path.length === 1 && method === "GET") {
      const kind = validKind(query.kind);
      const { records, cursor } = await xrpc<{ records: PublishedRecord[]; cursor?: string }>("com.atproto.repo.listRecords", {
        query: { repo: did, collection: collectionFor(kind), limit: "25", ...(query.after ? { cursor: query.after } : {}) },
      }).catch(error => {
        if (error instanceof PdsError && error.code === "RepoNotFound") return { records: [], cursor: undefined };
        throw error;
      });
      return json(200, { posts: records.map(item => {
        const { title, content } = extractFields(kind, item.value);
        return { rkey: item.uri.split("/").at(-1), title: title || content.slice(0, 120), createdAt: item.value.createdAt };
      }), cursor });
    }

    if (!path.length && method === "GET") {
      const after = query.after;
      if (after && !uuidPattern.test(after)) throw new HttpError(400, "Invalid draft cursor.");
      const result = await ddb.send(new QueryCommand({
        TableName: table, KeyConditionExpression: "did = :did", ExpressionAttributeValues: { ":did": did },
        Limit: 50, ...(after ? { ExclusiveStartKey: { did, id: after } } : {}),
      }));
      const drafts = (result.Items ?? []) as Draft[];
      return json(200, { cursor: result.LastEvaluatedKey?.id, drafts:
        drafts.map(({ id, kind, state, fields, updatedAt, scheduledAt }) => ({
          id, kind, state, updatedAt, scheduledAt,
          title: fields.title || fields.content.trim().slice(0, 100),
        })),
      });
    }

    if (!path.length && method === "POST") {
      const data = readJson(event) as { kind?: unknown; rkey?: unknown } | null;
      const kind = validKind(data?.kind);
      const rkey = data?.rkey;
      let fields = emptyDraftFields();
      let source: Draft["source"];
      if (rkey !== undefined) {
        if (typeof rkey !== "string" || !keyPattern.test(rkey)) throw new HttpError(400, "Invalid record key.");
        const record = await getRecord(did, kind, rkey);
        if (!record) throw new HttpError(404, "Post not found for this identity.");
        fields = extractFields(kind, record.value);
        source = { rkey, cid: record.cid };
      }
      const draft = await saveDraft({
        id: randomUUID(), did, kind, fields, source, media: {}, state: "draft", updatedAt: "", version: 0,
      }, undefined);
      return json(201, await view(draft, event));
    }

    const [id, action] = path;
    if (!uuidPattern.test(id ?? "") || path.length > 2) throw new HttpError(404, "Draft not found.");
    const draft = await getDraft(did, id);
    if (!draft) throw new HttpError(404, "Draft not found.");
    if (method === "GET" && !action) return json(200, await view(draft, event));

    const data = action === "media" || method === "DELETE" ? undefined : readJson(event) as {
      version?: unknown; fields?: unknown; enabled?: boolean; at?: unknown;
    } | null;
    const expected = action === "media" || method === "DELETE" ? Number(query.version) : data?.version;
    if (expected !== draft.version) throw new HttpError(409, "This draft changed. Reload before editing it again.");
    let next: Draft;

    if (!action && method === "DELETE") {
      if (draft.state === "publishing") throw new HttpError(409, "Publishing is in progress.");
      await ddb.send(new DeleteCommand({
        TableName: table, Key: { did, id }, ConditionExpression: "version = :old",
        ExpressionAttributeValues: { ":old": draft.version },
      }));
      await removeSchedule(draft.job?.id);
      const objects = Object.keys(draft.media).map(image => ({ Key: mediaKey(draft, image) }));
      if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }))
        .catch(error => console.warn("Draft media cleanup failed", (error as Error).name));
      return json(204);
    }
    requireEditable(draft);

    if (!action && method === "PUT") {
      next = { ...draft, fields: validateFields(data?.fields, draft) };
      // A malformed intermediate autosave must never become a scheduled public post.
      if (next.state === "scheduled") validatePublication(next);
    } else if (action === "media" && method === "POST") {
      if (draft.fields.images.length >= 4 || Object.keys(draft.media).length >= 40) {
        throw new HttpError(400, "A draft can have four attached images and forty uploads.");
      }
      const bytes = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
      const mime = imageMime(bytes);
      const image = randomUUID();
      const Key = mediaKey(draft, image);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: bytes, ContentType: mime, CacheControl: "private, no-store" }));
      try {
        next = await saveDraft({
          ...draft, media: { ...draft.media, [image]: mime },
          fields: { ...draft.fields, images: [...draft.fields.images, { id: image, alt: "" }] },
        }, draft.version);
      } catch (error) {
        if ((error as Error).name === "ConditionalCheckFailedException") {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })).catch(() => undefined);
        }
        throw error;
      }
      return json(200, await view(next, event));
    } else if (action === "share" && method === "POST") {
      if (typeof data?.enabled !== "boolean") throw new HttpError(400, "Choose whether to share the draft.");
      next = { ...draft, shareToken: data.enabled ? (draft.shareToken ?? randomBytes(32).toString("base64url")) : undefined };
    } else if (action === "cancel" && method === "POST") {
      if (draft.state !== "scheduled") throw new HttpError(409, "This draft has no pending schedule.");
      next = await saveDraft({
        ...draft, state: "draft", scheduledAt: undefined, job: undefined,
      }, draft.version);
      await removeSchedule(draft.job?.id);
      return json(200, await view(next, event));
    } else if ((action === "schedule" || action === "publish") && method === "POST") {
      next = await queuePublication(draft, email, action === "schedule" ? scheduleTime(data?.at) : undefined);
      return json(202, await view(next, event));
    } else {
      throw new HttpError(404, "Editor action not found.");
    }

    return json(200, await view(await saveDraft(next, draft.version), event));
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { message: error.message });
    if ((error as Error).name === "ConditionalCheckFailedException") {
      return json(409, { message: "This draft changed. Reload before editing it again." });
    }
    console.error("Editor request failed", (error as Error).name, error instanceof PdsError ? error.code : "");
    return json(503, { message: "The editor could not complete this request. Try again." });
  }
}
