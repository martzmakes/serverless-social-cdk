import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { verifyJwt } from "../auth/lib/jwt";
import { canShare, publishingHost, workspaceHost, workspaceSites } from "../auth/site-sharing";
import { mdToSafeHtml, renderVideoCompanion, VIDEO_COMPANION_CSS } from "../pds/longform-render";
import { emptyDraftFields, type EditorDraft, type PostKind } from "../../../editor";
import {
  collectionFor, extractFields, HttpError, imageMime, keyPattern, markdownWithImages, mediaKey,
  requireEditable, scheduleTime, uuidPattern, validateFields, validatePublication, type Draft, type Job,
} from "./model";
import {
  approvedIdentities, bucket, ddb, domain, env, getDraft, getRecord, getSharedDraft, PdsError,
  previewUrls, s3, saveDraft, sharing, table, xrpc, type PublishedRecord,
} from "./runtime";

import { handleLaunch } from "./launch-api";

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
  const video = draft.kind === "longform" ? renderVideoCompanion(draft.fields.video) : "";
  const content = draft.kind === "longform" ? markdown + video
    : `<p style="white-space:pre-wrap">${escapeHtml(draft.fields.content)}</p>${markdown}`;
  return {
    statusCode: 200,
    headers: {
      ...privateHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; img-src 'self' https://${domain}/xrpc/com.atproto.sync.getBlob; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
    body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{max-width:70ch;margin:4rem auto;padding:0 1.25rem;font:1.1rem/1.6 system-ui;color-scheme:light dark}img{max-width:100%}pre{overflow:auto}${video ? VIDEO_COMPANION_CSS : ""}</style><main><p>Unlisted preview</p><h1>${title}</h1>${content}</main></html>`,
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

async function copyDraft(draft: Draft, targetDid: string, requestId: string): Promise<Draft> {
  const hash = createHash("sha256").update(JSON.stringify([draft.did, draft.id, draft.version, targetDid, requestId])).digest("hex");
  const id = [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
  const existing = await getDraft(targetDid, id);
  if (existing) return existing;

  const media = Object.fromEntries(draft.fields.images.map(({ id }) => [id, draft.media[id]]));
  const copy: Draft = {
    id, did: targetDid, kind: draft.kind, version: 0, state: "draft", updatedAt: "", media,
    fields: { ...draft.fields, slug: "" },
  };
  const uploads = await Promise.allSettled(copy.fields.images.map(({ id }) =>
    s3.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: mediaKey(copy, id),
      CopySource: `${bucket}/${mediaKey(draft, id)}`,
    })),
  ));
  const failed = uploads.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  try {
    return await saveDraft(copy, undefined);
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") {
      const saved = await getDraft(targetDid, id);
      if (saved) return saved;
    }
    throw error;
  }
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
    const session = await verifyJwt(bearer[1]).catch(() => {
      throw new HttpError(401, "Sign in to use the editor.");
    });
    const { email } = session;
    const host = workspaceHost(session, event.headers["x-pds-viewer-host"], sharing);
    if (!host) throw new HttpError(403, "Sign in on this site to open its workspace.");
    const approved = await approvedIdentities(email);
    if (path.length === 1 && path[0] === "identities" && method === "GET") {
      const visible = await workspaceSites(sharing, approved, host);
      const identities = await Promise.all(visible.map(async identity => {
        const { did, handle } = identity;
        if (!sharing.table) return { did, handle };
        const from = publishingHost(identity, sharing);
        const targets = await Promise.all(approved.filter(target => target.did !== did).map(async target => {
          const to = publishingHost(target, sharing);
          if (!await canShare(sharing, from, to)) return;
          return { did: target.did, handle: target.handle, ...(visible.includes(target) ? {} : { host: to }) };
        }));
        return { did, handle, copyTargets: targets.filter(Boolean) };
      }));
      return json(200, { identities });
    }
    const query = event.queryStringParameters ?? {};
    const { did } = query;
    if (!did || !did.startsWith("did:") || did.length > 512) throw new HttpError(400, "Choose an identity.");
    const identity = approved.find(candidate => candidate.did === did);
    if (!identity) throw new HttpError(403, "This session cannot edit the selected identity.");
    const sourceHost = publishingHost(identity, sharing);
    if (!await canShare(sharing, sourceHost, host)) {
      throw new HttpError(403, "The selected site’s content is unavailable in this workspace.");
    }

    if (path[0] === "launches" && path.length === 2) {
      if (!sourceHost) throw new HttpError(403, "This identity has no publishing site.");
      let rkey: string;
      try { rkey = decodeURIComponent(path[1]); }
      catch { throw new HttpError(404, "This article is unavailable."); }
      return json(200, await handleLaunch({
        email, host, sourceHost, did, handle: identity.handle, rkey, method,
        ...(method === "POST" ? { body: readJson(event) } : {}),
      }));
    }

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
      version?: unknown; fields?: unknown; enabled?: boolean; at?: unknown; targetDid?: unknown; requestId?: unknown;
    } | null;
    const expected = action === "media" || method === "DELETE" ? Number(query.version) : data?.version;
    if (expected !== draft.version) throw new HttpError(409, "This draft changed. Reload before editing it again.");
    if (action === "copy" && method === "POST") {
      requireEditable(draft);
      const { targetDid, requestId } = data ?? {};
      if (typeof targetDid !== "string" || targetDid === did || targetDid.length > 512 || !targetDid.startsWith("did:")
          || typeof requestId !== "string" || !uuidPattern.test(requestId)) {
        throw new HttpError(400, "Choose a different publishing identity.");
      }
      const destination = approved.find(candidate => candidate.did === targetDid);
      if (!destination) throw new HttpError(403, "This session cannot edit the selected identity.");
      if (!await canShare(sharing, sourceHost, publishingHost(destination, sharing))) {
        throw new HttpError(403, "Cross-site sharing is disabled for this draft’s destination.");
      }
      return json(201, await view(await copyDraft(draft, targetDid, requestId), event));
    }
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
