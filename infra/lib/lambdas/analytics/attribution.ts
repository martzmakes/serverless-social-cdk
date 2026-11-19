import type { Device, Source } from "../../../insights";

const TAGS: Record<string, Source> = {
  linkedin: "linkedin", instagram: "instagram", facebook: "facebook",
  bluesky: "bluesky", mastodon: "fediverse", fediverse: "fediverse",
  activitypub: "fediverse", x: "x", twitter: "x", reddit: "reddit",
  threads: "threads", email: "email", newsletter: "email", rss: "rss",
};

const REFERRERS: Record<string, Source> = {
  "linkedin.com": "linkedin", "lnkd.in": "linkedin", "instagram.com": "instagram",
  "facebook.com": "facebook", "fb.me": "facebook", "bsky.app": "bluesky",
  "bsky.social": "bluesky", "mastodon.social": "fediverse", "mastodon.online": "fediverse",
  "fosstodon.org": "fediverse", "x.com": "x", "twitter.com": "x", "t.co": "x",
  "reddit.com": "reddit", "redd.it": "reddit", "threads.net": "threads",
  "threads.com": "threads", "google.com": "search", "google.co.uk": "search",
  "bing.com": "search", "duckduckgo.com": "search", "search.yahoo.com": "search",
  "yahoo.com": "search", "ecosia.org": "search", "kagi.com": "search",
};

export function decodeLogField(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function classifySource(query: string | undefined, domain: string, sameSite: boolean): Source {
  if (query && query !== "-") {
    // A log can contain the query directly or URL-encode the entire field.
    const params = new URLSearchParams(query.includes("=") ? query : decodeLogField(query));
    const tag = params.get("utm_source")?.trim().toLowerCase();
    if (tag && Object.hasOwn(TAGS, tag)) return TAGS[tag];
  }
  if (sameSite) return "internal";
  if (Object.hasOwn(REFERRERS, domain)) return REFERRERS[domain];
  return domain === "direct" ? "direct" : "other";
}

export function classifyDevice(agent: string): Device {
  if (/ipad|tablet|macintosh.*mobile|kindle|silk\//i.test(agent)) return "tablet";
  if (/iphone|ipod|mobile|iemobile/i.test(agent)) return "mobile";
  if (/android/i.test(agent)) return "tablet";
  if (/windows nt|macintosh|x11|cros|linux x86/i.test(agent)) return "desktop";
  return "unknown";
}
