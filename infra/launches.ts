import { taggedArticleUrl, type InsightArticle } from "./insights";

export const launchPlatforms = ["bluesky", "fediverse"] as const;
export type LaunchPlatform = typeof launchPlatforms[number];
export type LaunchChannelInput = { text: string; enabled: boolean };
export type LaunchInputs = Record<LaunchPlatform, LaunchChannelInput>;
export type LaunchChannel = LaunchChannelInput & {
  state: "draft" | "failed" | "posted" | "queued" | "automatic";
  url?: string;
  error?: string;
};

export type ArticleLaunch = {
  article: InsightArticle;
  description: string;
  mode: "managed" | "automatic";
  channels: Record<LaunchPlatform, LaunchChannel>;
  version: number;
  run?: { at?: string; platforms: LaunchPlatform[] };
};

export const launchLimit = { bluesky: 300, fediverse: 500 };
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function launchLink(url: string, platform: LaunchPlatform) {
  return taggedArticleUrl(url, platform);
}

function launchText(text: string, url: string, platform: LaunchPlatform) {
  const announcement = text.trim();
  return announcement + (announcement ? "\n\n" : "") + launchLink(url, platform);
}

export function launchLength(text: string, url: string, platform: LaunchPlatform) {
  const value = launchText(text, url, platform);
  return segmenter ? Array.from(segmenter.segment(value)).length : Array.from(value).length;
}

export function fitsLaunchLimit(text: string, url: string, platform: LaunchPlatform) {
  return launchLength(text, url, platform) <= launchLimit[platform] &&
    (platform !== "bluesky" || new TextEncoder().encode(launchText(text, url, platform)).byteLength <= 3_000);
}

export class LaunchesError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createLaunchesClient({ origin, token, fetch: send = fetch }: {
  origin: string;
  token: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof fetch;
}) {
  async function request(did: string, rkey: string, body?: object): Promise<ArticleLaunch> {
    const credential = await token();
    if (!credential) throw new LaunchesError(401, "Sign in to manage article launches.");
    const url = new URL(`/auth/editor/launches/${encodeURIComponent(rkey)}`, origin);
    url.searchParams.set("did", did);
    const response = await send(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${credential}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => undefined);
    if (!response.ok || !result) throw new LaunchesError(response.status, result?.message ?? "Article launches are unavailable on this site.");
    return result;
  }

  return {
    load: (did: string, rkey: string) => request(did, rkey),
    save: (did: string, rkey: string, version: number, channels: LaunchInputs) =>
      request(did, rkey, { action: "save", version, channels }),
    launch: (did: string, rkey: string, version: number, channels: LaunchInputs, at?: string) =>
      request(did, rkey, { action: "launch", version, channels, at }),
    retry: (did: string, rkey: string, version: number) =>
      request(did, rkey, { action: "retry", version }),
    cancel: (did: string, rkey: string, version: number) =>
      request(did, rkey, { action: "cancel", version }),
  };
}

export type LaunchesClient = ReturnType<typeof createLaunchesClient>;
