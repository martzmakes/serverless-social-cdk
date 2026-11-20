import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalApOrigin, parseCustomHosts } from "../ap/host";
import { blueskyLink } from "../analytics/reply-actions";
import { articleFromIndexRow } from "../pds/longform-index";
import type { ArticleLaunch } from "../../../launches";
import { HttpError } from "./model";
import { initialLaunch, type LaunchRow } from "./launch-model";
import { ddb, env, sharing, table } from "./runtime";

const storageKey = (did: string, rkey: string) => ({ did: `LAUNCH#${did}`, id: rkey });
const indexKey = (did: string, rkey: string) => ({ pk: did === sharing.apexDid ? "IDX" : `IDX#${did}`, sk: rkey });

export function ensureLaunchesEnabled() {
  if (!env.LONGFORM_INDEX_TABLE || !env.AP_LAUNCH_QUEUE_URL) {
    throw new HttpError(503, "Article launches are unavailable on this site.");
  }
}

export async function launchContext(did: string, rkey: string, host: string, handle: string) {
  ensureLaunchesEnabled();
  const { Item } = await ddb.send(new GetCommand({
    TableName: env.LONGFORM_INDEX_TABLE,
    Key: indexKey(did, rkey),
    ConsistentRead: true,
  }));
  const item = articleFromIndexRow(Item);
  if (!item || item.status !== "published" || !/^[a-z0-9-]+$/.test(item.currentSlug)) {
    throw new HttpError(404, "Publish the article before planning its social launch.");
  }
  const activityPubUrl = `${canonicalApOrigin(handle, parseCustomHosts(env.AP_CUSTOM_HOSTS))}/ap/users/${encodeURIComponent(handle)}/articles/${encodeURIComponent(rkey)}`;
  const article = {
    rkey, title: item.title, url: `https://${host}/${item.currentSlug}`, publishedAt: item.publishedAt,
    blueskyUrl: blueskyLink(item.syndication?.bsky?.uri ?? ""),
  };
  return { article, item, activityPubUrl };
}

export async function getLaunch(did: string, rkey: string): Promise<LaunchRow | undefined> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: table, Key: storageKey(did, rkey), ConsistentRead: true,
  }));
  return Item?.launch;
}

export async function putLaunch(row: LaunchRow): Promise<LaunchRow> {
  const next = { ...row, version: row.version + 1 };
  await ddb.send(new PutCommand({
    TableName: table, Item: { ...storageKey(row.did, row.rkey), launch: next, version: next.version },
    ...(row.version
      ? { ConditionExpression: "version = :prior", ExpressionAttributeValues: { ":prior": row.version } }
      : { ConditionExpression: "attribute_not_exists(id)" }),
  }));
  return next;
}

export function launchView(context: Awaited<ReturnType<typeof launchContext>>, row: LaunchRow | undefined): ArticleLaunch {
  const { article, item, activityPubUrl } = context;
  const stored = row ?? initialLaunch("", item, activityPubUrl);
  return {
    article, description: item.excerpt, mode: item.managedLaunch ? "managed" : "automatic",
    channels: {
      ...stored.channels,
      bluesky: article.blueskyUrl ? {
        ...stored.channels.bluesky, state: "posted", url: article.blueskyUrl, error: undefined,
      } : stored.channels.bluesky,
    },
    version: stored.version,
    ...(stored.job ? { run: { at: stored.job.at, platforms: stored.job.platforms } } : {}),
  };
}

// Launch metadata is individually updated alongside the renderer's article item.
// Keep it across edits, including a simultaneous update to the article body.
export async function indexLaunch(
  did: string, rkey: string,
  change: { field: "launchBluesky"; value: { uri: string; cid: string } } |
          { field: "launchActivityPub"; value: { text: string; publishedAt: string } },
) {
  await ddb.send(new UpdateCommand({
    TableName: env.LONGFORM_INDEX_TABLE, Key: indexKey(did, rkey),
    UpdateExpression: "SET #field = if_not_exists(#field, :value)",
    ConditionExpression: "#item.#status = :published AND #item.managedLaunch = :managed",
    ExpressionAttributeNames: { "#field": change.field, "#item": "item", "#status": "status" },
    ExpressionAttributeValues: { ":value": change.value, ":published": "published", ":managed": true },
  }));
}
