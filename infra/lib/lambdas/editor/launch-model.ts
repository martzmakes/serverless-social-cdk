import {
  fitsLaunchLimit, launchLimit, launchLink, launchPlatforms,
  type ArticleLaunch, type LaunchChannel, type LaunchPlatform,
} from "../../../launches";
import type { IndexItem } from "../pds/longform-index";
import { HttpError } from "./model";

export type LaunchJob = { did: string; launchRkey: string; jobId: string };
export type LaunchRow = {
  did: string;
  rkey: string;
  version: number;
  channels: ArticleLaunch["channels"];
  job?: { id: string; email: string; host: string; platforms: LaunchPlatform[]; at?: string; leaseUntil?: number };
  bluesky?: { rkey: string; createdAt: string; title: string; excerpt: string; url: string };
};

export function initialLaunch(did: string, item: IndexItem, activityPubUrl: string): LaunchRow {
  return {
    did, rkey: item.rkey, version: 0,
    channels: {
      bluesky: { enabled: true, state: item.managedLaunch ? "draft" : "automatic", text: "" },
      fediverse: { enabled: true, state: item.managedLaunch ? "draft" : "automatic", text: "", ...(item.managedLaunch ? {} : { url: activityPubUrl }) },
    },
  };
}

export function applyChannelEdits(row: LaunchRow, input: unknown) {
  const values = input as Partial<Record<LaunchPlatform, Partial<LaunchChannel>>> | null | undefined;
  if (!values || typeof values !== "object") throw new HttpError(400, "Enter announcement details.");
  const channels = { ...row.channels };
  // A network attempt freezes its payload so redelivery can reconcile
  // the same public record or Activity.
  for (const platform of launchPlatforms) {
    const current = channels[platform];
    if (current.state !== "draft") continue;
    const update = values[platform];
    if (typeof update?.text !== "string" || Buffer.byteLength(update.text) > 12_000 || typeof update.enabled !== "boolean") {
      throw new HttpError(400, "Enter valid announcement text and select the networks to use.");
    }
    channels[platform] = { ...current, text: update.text.trim(), enabled: update.enabled };
  }
  return { ...row, channels };
}

export function launchTargets(row: LaunchRow, action: "launch" | "retry", url: string): LaunchPlatform[] {
  const selected = launchPlatforms.filter(platform => {
    const channel = row.channels[platform];
    return action === "retry" ? channel.state === "failed" : channel.enabled && channel.state === "draft";
  });
  if (!selected.length) throw new HttpError(400, action === "retry" ? "There are no failed announcements to retry." : "Choose a network to announce on.");
  for (const platform of selected) {
    if (!fitsLaunchLimit(row.channels[platform].text, url, platform)) {
      const name = platform === "bluesky" ? "Bluesky" : "ActivityPub";
      throw new HttpError(400, `${name} announcement is too long. Use up to ${launchLimit[platform]} characters including the article link.`);
    }
  }
  return selected;
}

export function makeLaunchPost(row: LaunchRow) {
  const attempt = row.bluesky!;
  const uri = launchLink(attempt.url, "bluesky");
  const caption = row.channels.bluesky.text;
  const prefix = caption ? `${caption}\n\n` : "";
  return {
    $type: "app.bsky.feed.post",
    text: prefix + uri,
    createdAt: attempt.createdAt,
    facets: [{
      index: { byteStart: Buffer.byteLength(prefix), byteEnd: Buffer.byteLength(prefix + uri) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    }],
    // Use the measured link as the card destination too. The site's AP relay
    // recognizes the article by tenant and pathname, including with UTM tags.
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri, title: Array.from(attempt.title).slice(0, 300).join(""),
        description: Array.from(attempt.excerpt || caption).slice(0, 1_000).join(""),
      },
    },
  };
}
