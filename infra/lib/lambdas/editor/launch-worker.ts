import { randomInt } from "node:crypto";
import { TID } from "@atproto/common-web";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { fitsLaunchLimit, type LaunchPlatform } from "../../../launches";
import { blueskyLink } from "../analytics/reply-actions";
import { canShare, publishingHost } from "../auth/site-sharing";
import { HttpError } from "./model";
import { makeLaunchPost, type LaunchJob, type LaunchRow } from "./launch-model";
import { getLaunch, indexLaunch, launchContext, putLaunch } from "./launch-storage";
import { approvedIdentities, env, getRecord, publicationToken, sharing, xrpc } from "./runtime";

const sqs = new SQSClient({});
type Context = Awaited<ReturnType<typeof launchContext>>;
const collection = "app.bsky.feed.post";

export function hasCanonical(html: string, url: string): boolean {
  const root = parse(html).childNodes.find(node => node.nodeName === "html") as DefaultTreeAdapterTypes.Element | undefined;
  const head = root?.childNodes.find(node => node.nodeName === "head") as DefaultTreeAdapterTypes.Element | undefined;
  return head?.childNodes.some(node => {
    if (node.nodeName !== "link" || !("attrs" in node)) return false;
    const rel = node.attrs.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/);
    return rel?.includes("canonical") && node.attrs.find(attribute => attribute.name === "href")?.value === url;
  }) ?? false;
}

async function canonicalIsPublic(url: string) {
  // The URL is constructed from deployment-approved host and renderer slug.
  // Reject redirects and verify the HTML to catch a 200 fallback app shell.
  const response = await fetch(url, {
    redirect: "error", headers: { Range: "bytes=0-65535" }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    await response.body?.cancel();
    return false;
  }
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (received < 65_536) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value.subarray(0, 65_536 - received), { stream: true });
      received += value.byteLength;
      if (/<\/head\s*>/i.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return hasCanonical(text, url);
}

async function postBluesky(row: LaunchRow) {
  const attempt = row.bluesky!;
  const record = makeLaunchPost(row);
  const prior = await getRecord(row.did, "post", attempt.rkey);
  let result: { uri: string; cid: string };
  if (prior) {
    const value = prior.value;
    const external = (value.embed as typeof record.embed | undefined)?.external;
    if (value.$type !== record.$type || value.createdAt !== record.createdAt ||
        value.text !== record.text || external?.uri !== record.embed.external.uri) {
      throw new Error("The reserved Bluesky key is occupied.");
    }
    result = prior;
  } else {
    result = await xrpc("com.atproto.repo.putRecord", {
      token: await publicationToken(row.job!.email, row.did),
      body: { repo: row.did, rkey: attempt.rkey, collection, swapRecord: null, record },
    });
  }
  const url = blueskyLink(result.uri);
  if (!url || !result.cid) throw new Error("The Bluesky record result was invalid.");
  await indexLaunch(row.did, row.rkey, { field: "launchBluesky", value: { uri: result.uri, cid: result.cid } });
  return url;
}

async function queueActivityPub(row: LaunchRow, context: Context) {
  await indexLaunch(row.did, row.rkey, {
    field: "launchActivityPub",
    value: { text: row.channels.fediverse.text, publishedAt: new Date().toISOString() },
  });
  const event = { did: row.did, rkey: row.rkey, op: "create", collection: "social.serverless.longform", launch: true };
  await sqs.send(new SendMessageCommand({
    QueueUrl: env.AP_LAUNCH_QUEUE_URL, MessageBody: JSON.stringify({ kind: "event", event }),
  }));
  return context.activityPubUrl;
}

function updateChannel(row: LaunchRow, platform: LaunchPlatform, value: Partial<LaunchRow["channels"][LaunchPlatform]>) {
  return { ...row, channels: { ...row.channels, [platform]: { ...row.channels[platform], ...value } } };
}

function failRun(row: LaunchRow, error: string) {
  for (const platform of row.job!.platforms) {
    const state = row.channels[platform].state;
    if (state === "draft" || state === "failed") row = updateChannel(row, platform, { state: "failed", error });
  }
  return putLaunch({ ...row, job: undefined });
}

export async function processLaunch(job: LaunchJob, lastTry: boolean) {
  let row = await getLaunch(job.did, job.launchRkey);
  if (!row || row.job?.id !== job.jobId) return;
  const now = Date.now();
  if (row.job.at && Date.parse(row.job.at) > now) throw new Error("The launch is not due yet.");
  if ((row.job.leaseUntil ?? 0) > now) throw new Error("The launch is already running.");
  row = await putLaunch({ ...row, job: { ...row.job, leaseUntil: now + 90_000 } });

  let context: Context;
  try {
    const identity = (await approvedIdentities(row.job!.email)).find(candidate => candidate.did === row?.did);
    const sourceHost = identity && publishingHost(identity, sharing);
    if (!identity || !sourceHost || !sharing.hosts.has(row.job!.host) || !await canShare(sharing, sourceHost, row.job!.host)) {
      throw new HttpError(403, "This workspace no longer has access to this publishing identity.");
    }
    context = await launchContext(row.did, row.rkey, sourceHost, identity.handle);
    if (!context.item.managedLaunch) throw new HttpError(409, "This article uses automatic syndication.");
    if (!await canonicalIsPublic(context.article.url)) throw new Error("Canonical article is not public yet.");
  } catch (error) {
    if (error instanceof HttpError || lastTry) {
      await failRun(row, error instanceof HttpError ? error.message : "The public article could not be verified. Check the article link and retry.");
      return;
    }
    throw error;
  }

  for (const platform of row.job!.platforms) {
    const { state, text } = row.channels[platform];
    if (state !== "draft" && state !== "failed") continue;
    if (!fitsLaunchLimit(text, context.article.url, platform) && (platform !== "bluesky" || !row.bluesky)) {
      row = await putLaunch(updateChannel(row, platform, { state: "failed", error: "The article link is now too long for this announcement." }));
      continue;
    }
    if (platform === "bluesky" && !row.bluesky) {
      const at = Date.now();
      row = await putLaunch({
        ...row,
        bluesky: {
          rkey: TID.fromTime(at * 1_000 + randomInt(1_000), randomInt(1_024)).toString(),
          createdAt: new Date(at).toISOString(), title: context.article.title,
          excerpt: context.item.excerpt, url: context.article.url,
        },
      });
    }
    let url: string;
    try {
      url = platform === "bluesky" ? await postBluesky(row) : await queueActivityPub(row, context);
    } catch (error) {
      console.warn("Announcement attempt failed", platform, (error as Error).name);
      row = await putLaunch(updateChannel(row, platform, {
        state: "failed", error: platform === "bluesky"
          ? "Bluesky did not confirm the announcement. Retry to check or resend it."
          : "The ActivityPub worker did not confirm the queue request. Retry to queue it again.",
      }));
      continue;
    }
    row = await putLaunch(updateChannel(row, platform, {
      state: platform === "bluesky" ? "posted" : "queued", url, error: undefined,
    }));
  }
  await putLaunch({ ...row, job: undefined });
}
