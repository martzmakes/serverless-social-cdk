export type VideoCompanion = { url: string; title?: string };

export const videoTitleLimit = 120;

/** Accept common YouTube video links and discard query parameters used for sharing or tracking. */
export function normalizeVideoCompanion(input: unknown): VideoCompanion | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { url, title } = input as Partial<VideoCompanion>;
  if (typeof url !== "string" || url.length > 2_048 ||
      (title !== undefined && (typeof title !== "string" || title.length > videoTitleLimit))) return;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return;

  let id: string | null = null;
  if (parsed.hostname === "youtu.be") {
    id = parsed.pathname.match(/^\/([\w-]+)\/?$/)?.[1] ?? null;
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname)) {
    id = parsed.pathname === "/watch" ? parsed.searchParams.get("v")
      : parsed.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)\/?$/)?.[1] ?? null;
  } else if (parsed.hostname === "www.youtube-nocookie.com") {
    id = parsed.pathname.match(/^\/embed\/([\w-]+)\/?$/)?.[1] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return;
  const cleanTitle = title?.trim();
  return { url: `https://www.youtube.com/watch?v=${id}`, ...(cleanTitle ? { title: cleanTitle } : {}) };
}
