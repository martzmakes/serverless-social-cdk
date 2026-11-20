/** Browser-safe contract for the author insights endpoint. */
export const SOURCES = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  bluesky: "Bluesky",
  fediverse: "Fediverse",
  x: "X",
  reddit: "Reddit",
  threads: "Threads",
  search: "Search",
  email: "Email",
  rss: "RSS",
  internal: "Same site",
  direct: "Direct or unavailable",
  other: "Other referrer",
} as const;

export const DEVICES = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
  unknown: "Unknown",
} as const;

export type Source = keyof typeof SOURCES;
export type Device = keyof typeof DEVICES;
export type InsightDays = 7 | 30 | 90;
export type InsightSite = { did: string; handle: string; host: string };
export type InsightArticle = { rkey: string; title: string; url: string; publishedAt: string; blueskyUrl?: string };
export type ArticleInsights = {
  article: InsightArticle;
  views: number;
  classifiedViews: number;
  daily: { day: string; views: number }[];
  sources: Partial<Record<Source, number>>;
  devices: Partial<Record<Device, number>>;
  referrers: { host: string; views: number }[];
};

export type ArticleDistribution = {
  activityPubUrl: string;
  bluesky?: { day: string; likes: number; reposts: number; replies: number };
  socialCard?: { title: string; description?: string; image?: string; imageAlt?: string };
};

export type ReplyNetwork = "Bluesky" | "Fediverse";
export type ArticleReply = {
  id: string;
  network: ReplyNetwork;
  author: string;
  text: string;
  url: string;
  publishedAt: string;
  handled?: boolean;
};
export type ReplySubmission = { status: "sent" | "queued"; url: string };
export type ArticleReplies = { replies: ArticleReply[]; unavailable: ReplyNetwork[]; next?: string };
export type ReplyQueueThread = ArticleReplies & { article: InsightArticle };
export type ReplyQueuePage = { threads: ReplyQueueThread[]; next?: string };
export type SharingDirections = { outgoing: boolean; incoming: boolean };
export type SiteSharing = { host: string; peers: ({ host: string } & SharingDirections)[] };

export const SHARE_SOURCES = [
  "linkedin", "instagram", "facebook", "bluesky", "fediverse", "x", "reddit", "threads", "email", "rss",
] as const satisfies readonly Source[];

export function taggedArticleUrl(url: string, source: typeof SHARE_SOURCES[number]) {
  const link = new URL(url);
  link.searchParams.set("utm_source", source);
  return link.toString();
}

export class InsightsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createInsightsClient({ origin, token }: { origin: string; token: () => string | null | undefined | Promise<string | null | undefined> }) {
  async function request<T>(path: string, query?: Record<string, string>, body?: object): Promise<T> {
    const session = await token();
    if (!session) throw new InsightsError(401, "Sign in to view article analytics.");
    const url = new URL(`/auth/insights${path}`, origin);
    url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${session}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 || !response.headers.get("content-type")?.includes("application/json")) {
      throw new InsightsError(response.status, response.ok || path === "" ? "Article analytics is unavailable on this deployment." : "This article is unavailable.");
    }
    const payload = await response.json() as T & { message?: string };
    if (!response.ok) throw new InsightsError(response.status, payload.message ?? (body ? "Could not update article replies." : "Could not load analytics."));
    return payload;
  }
  return {
    sites: () => request<{ sites: InsightSite[] }>(""),
    sharing: () => request<SiteSharing>("/sharing"),
    updateSharing: (peer: string, directions: SharingDirections) =>
      request<SharingDirections>("/sharing", undefined, { peer, ...directions }),
    articles: (did: string, after?: string) => request<{ articles: InsightArticle[]; next?: string }>(
      "/articles", { did, ...(after ? { after } : {}) },
    ),
    replyQueue: (did: string, after?: string) => request<ReplyQueuePage>(
      "/replies", { did, ...(after ? { after } : {}) },
    ),
    replies: (did: string, rkey: string, after?: string) => request<ArticleReplies>(
      `/articles/${encodeURIComponent(rkey)}/replies`, { did, ...(after ? { after } : {}) },
    ),
    setReplyHandled: (did: string, rkey: string, target: Pick<ArticleReply, "network" | "id">, handled: boolean) =>
      request<{ handled: boolean }>(`/articles/${encodeURIComponent(rkey)}/replies`, { did },
        { action: "handled", id: target.id, network: target.network, handled }),
    sendReply: (did: string, rkey: string, target: Pick<ArticleReply, "network" | "id">, text: string, requestId: string) =>
      request<ReplySubmission>(`/articles/${encodeURIComponent(rkey)}/replies`, { did },
        { action: "send", id: target.id, network: target.network, text, requestId }),
    distribution: (did: string, rkey: string) => request<ArticleDistribution>(
      `/articles/${encodeURIComponent(rkey)}/distribution`, { did },
    ),
    article: (did: string, rkey: string, days: InsightDays) => request<ArticleInsights>(
      `/articles/${encodeURIComponent(rkey)}`, { did, days: String(days) },
    ),
  };
}

export type InsightsClient = ReturnType<typeof createInsightsClient>;
