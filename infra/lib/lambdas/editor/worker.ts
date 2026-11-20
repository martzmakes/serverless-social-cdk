import type { SQSHandler } from "aws-lambda";
import { createHash, randomInt } from "node:crypto";
import { TID } from "@atproto/common-web";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  collectionFor, HttpError, longformFields, markdownWithImages, mediaKey, validatePublication,
  type Draft, type Job, type RecordValue,
} from "./model";
import { bucket, domain, getDraft, getRecord, PdsError, publicationToken, s3, saveDraft, xrpc } from "./runtime";

import { processLaunch } from "./launch-worker";
import type { LaunchJob } from "./launch-model";

type BlobRef = { $type: "blob"; ref: { $link: string }; mimeType: string; size: number };

function fingerprint(value: RecordValue) {
  const encoded = JSON.stringify(value, (_, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash("sha256").update(encoded).digest("hex");
}

async function assemble(draft: Draft, original: RecordValue | undefined, token: string): Promise<RecordValue> {
  const images = await Promise.all(draft.fields.images.map(async ({ id, alt }) => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: mediaKey(draft, id) }));
    if (!object.Body) throw new Error("Draft image missing");
    const bytes = await object.Body.transformToByteArray();
    const { blob } = await xrpc<{ blob: BlobRef }>("com.atproto.repo.uploadBlob", {
      token, body: bytes, mime: draft.media[id],
    });
    const query = new URLSearchParams({ did: draft.did, cid: blob.ref.$link });
    return { image: blob, alt, id, url: `https://${domain}/xrpc/com.atproto.sync.getBlob?${query}` };
  }));
  const common = {
    ...original, $type: collectionFor(draft.kind), createdAt: original?.createdAt ?? draft.attempt!.createdAt,
  };
  if (draft.kind === "longform") {
    const urls = Object.fromEntries(images.map(({ id, url }) => [id, url]));
    const content = markdownWithImages(draft, urls).trim();
    const references = [...(Array.isArray(original?.media) ? original.media : []), ...images.map(({ image }) => image)]
      .filter((media, index, refs) => {
        const cid = (media as BlobRef)?.ref?.$link;
        return cid && content.includes(cid) && refs.findIndex(ref => (ref as BlobRef)?.ref?.$link === cid) === index;
      });
    const article: RecordValue = {
      ...common, ...longformFields(draft, content), ...(references.length || original?.media ? { media: references } : {}),
    };
    if (!draft.fields.video) delete article.video;
    return article;
  }
  const text = draft.fields.content.trim();
  const post: RecordValue = { ...common, text };
  if (text !== original?.text) delete post.facets;
  if (images.length) {
    const embed = original?.embed as RecordValue | undefined;
    const media = { $type: "app.bsky.embed.images", images: images.map(({ image, alt }) => ({ image, alt })) };
    if (embed?.$type === "app.bsky.embed.recordWithMedia") post.embed = { ...embed, media };
    else if (embed?.$type === "app.bsky.embed.record") post.embed = { $type: "app.bsky.embed.recordWithMedia", record: embed, media };
    else post.embed = media;
  }
  if (!text && !post.embed) throw new HttpError(400, "Write a post or attach an image.");
  return post;
}

async function processPublication(job: Job, lastTry: boolean) {
  let draft = await getDraft(job.did, job.id);
  if (!draft || draft.job?.id !== job.jobId || !["publishing", "scheduled"].includes(draft.state)) return;
  const now = Date.now();
  if (draft.scheduledAt && now < Date.parse(draft.scheduledAt)) throw new Error("Publication is not due");
  if (draft.attempt && draft.attempt.leaseUntil > now) throw new Error("Publication already in progress");
  const attempt = {
    rkey: draft.attempt?.rkey ?? draft.source?.rkey ?? TID.fromTime(now * 1000 + randomInt(1000), randomInt(1024)).toString(),
    createdAt: draft.attempt?.createdAt ?? new Date(now).toISOString(),
    fingerprint: draft.attempt?.fingerprint,
    leaseUntil: now + 90_000,
  };
  draft = await saveDraft({ ...draft, state: "publishing", attempt }, draft.version);

  try {
    validatePublication(draft);
    const token = await publicationToken(draft.job!.email, draft.did);
    const current = await getRecord(draft.did, draft.kind, attempt.rkey);
    let result: { uri: string; cid: string };
    if (current && attempt.fingerprint && fingerprint(current.value) === attempt.fingerprint) {
      result = current;
    } else {
      if ((current?.cid ?? null) !== (draft.source?.cid ?? null)) {
        throw new HttpError(409, "The original post changed. Open a fresh revision from Published.");
      }
      const record = await assemble(draft, current?.value, token);
      // Persist the intent before writing the public record. Redelivery can reconcile
      // a response lost after the PDS commits using the same key and fingerprint.
      attempt.fingerprint = fingerprint(record);
      draft = await saveDraft({ ...draft, attempt }, draft.version);
      result = await xrpc("com.atproto.repo.putRecord", {
        token, body: {
          repo: draft.did, collection: collectionFor(draft.kind), rkey: attempt.rkey,
          swapRecord: draft.source?.cid ?? null, record,
        },
      });
    }
    await saveDraft({
      ...draft, state: "published", job: undefined, scheduledAt: undefined, shareToken: undefined,
      attempt: undefined, error: undefined, result: { uri: result.uri, cid: result.cid, rkey: attempt.rkey },
    }, draft.version);
  } catch (error) {
    const permanent = error instanceof HttpError ||
      (error instanceof PdsError && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429);
    if (permanent || lastTry) {
      await saveDraft({
        ...draft, state: "failed", job: undefined, scheduledAt: undefined,
        attempt: { ...attempt, leaseUntil: 0 },
        error: error instanceof HttpError ? error.message : "Publishing failed. Review the draft and try again.",
      }, draft.version);
      if (permanent) return;
    }
    throw error;
  }
}

export const handler: SQSHandler = async event => {
  for (const delivery of event.Records) {
    const job = JSON.parse(delivery.body) as Job | LaunchJob;
    try {
      const lastTry = Number(delivery.attributes.ApproximateReceiveCount) >= 4;
      if ("launchRkey" in job) await processLaunch(job, lastTry);
      else await processPublication(job, lastTry);
    } catch (error) {
      console.warn("Publication worker will retry", (error as Error).name);
      // Avoid copying private authoring data or function response bodies to logs.
      throw new Error("Publication attempt failed");
    }
  }
};
