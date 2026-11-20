import { draftMarkdown, emptyDraftFields, type DraftFields, type EditorDraft, type PostKind } from "../../../editor";
import { normalizeVideoCompanion } from "../../../youtube";
import { safeSlug } from "../pds/longform-routing";

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const keyPattern = /^(?!\.{1,2}$)[a-zA-Z0-9._~:-]{1,512}$/;
export const maxUploadBytes = 1_000_000;
const maxContentBytes = 112_000;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export type RecordValue = Record<string, unknown>;
export type Draft = Omit<EditorDraft, "shareUrl" | "previews"> & {
  media: Record<string, string>;
  source?: { rkey: string; cid: string };
  shareToken?: string;
  job?: { id: string; email: string };
  attempt?: { leaseUntil: number; createdAt: string; rkey: string; fingerprint?: string };
};
export type Job = { id: string; did: string; jobId: string };

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const collectionFor = (kind: PostKind) => kind === "post" ? "app.bsky.feed.post" : "social.serverless.longform";
export const mediaKey = (draft: Draft, image: string) => `${draft.id}/${image}`;

export function textField(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) {
    throw new HttpError(400, "A field exceeds its size limit or has an invalid value.");
  }
  return value;
}

export function validateFields(input: unknown, draft: Draft): DraftFields {
  const f = input as Partial<DraftFields> | undefined;
  if (!f || !Array.isArray(f.images) || f.images.length > 4 || !Array.isArray(f.tags) || f.tags.length > 12 ||
      typeof f.syndicate !== "boolean") {
    throw new HttpError(400, "A draft can have up to four images and twelve tags.");
  }
  const images = f.images.map(image => {
    if (typeof image?.id !== "string" || !Object.hasOwn(draft.media, image.id)) {
      throw new HttpError(400, "Choose an image uploaded to this draft.");
    }
    return { id: image.id, alt: textField(image.alt, 2000) };
  });
  if (new Set(images.map(image => image.id)).size !== images.length) {
    throw new HttpError(400, "Each image can be attached once.");
  }
  const video = normalizeVideoCompanion(f.video);
  if (f.video !== undefined && (draft.kind !== "longform" || !video)) {
    throw new HttpError(400, "Add a valid HTTPS YouTube video link and an optional title.");
  }
  if (f.managedLaunch !== undefined && (draft.kind !== "longform" || typeof f.managedLaunch !== "boolean")) {
    throw new HttpError(400, "Launch planning applies to articles.");
  }
  const managedLaunch = draft.source ? draft.fields.managedLaunch : f.managedLaunch;
  return {
    content: textField(f.content, maxContentBytes),
    title: textField(f.title, 1200),
    slug: textField(f.slug, 800),
    excerpt: textField(f.excerpt, 4000),
    teaser: textField(f.teaser, 3000),
    tags: f.tags.map(tag => textField(tag, 200).trim()).filter(Boolean),
    syndicate: f.syndicate,
    images,
    ...(video && { video }),
    ...(managedLaunch && { managedLaunch: true }),
  };
}

export function imageMime(bytes: Buffer): string {
  if (!bytes.length || bytes.length > maxUploadBytes) throw new HttpError(413, "Use an image up to 1 MB.");
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new HttpError(415, "Choose a PNG, JPEG, or WebP image.");
}

export function extractFields(kind: PostKind, value: RecordValue): DraftFields {
  const string = (v: unknown) => typeof v === "string" ? v : "";
  const video = kind === "longform" ? normalizeVideoCompanion(value.video) : undefined;
  return {
    ...emptyDraftFields(),
    content: string(kind === "post" ? value.text : value.content),
    title: string(value.title),
    slug: string(value.slug),
    excerpt: string(value.excerpt),
    tags: Array.isArray(value.tags) ? value.tags.filter((v): v is string => typeof v === "string") : [],
    teaser: string(value.syndicationTeaser),
    syndicate: value.syndicate !== false,
    ...(video && { video }),
    ...(kind === "longform" && value.managedLaunch === true && { managedLaunch: true }),
  };
}

export function requireEditable(draft: Draft) {
  if (draft.state === "publishing" || draft.state === "published") {
    throw new HttpError(409, "Open a new revision to edit a published post.");
  }
}

export function validatePublication(draft: Draft) {
  const { content, title, images } = draft.fields;
  if (draft.kind === "longform") {
    if (!title.trim() || !content.trim()) throw new HttpError(400, "Enter a title and article body.");
    for (const match of content.matchAll(/draft-image:([\w-]+)/g)) {
      if (!images.some(image => image.id === match[1])) {
        throw new HttpError(400, "Remove the Markdown reference to the detached image.");
      }
    }
  } else {
    const length = [...graphemes.segment(content.trim())].length;
    if ((!length && !images.length && !draft.source) || length > 300 || Buffer.byteLength(content.trim()) > 3000) {
      throw new HttpError(400, "Write up to 300 characters or attach an image.");
    }
  }
}

export function scheduleTime(input: unknown, now = Date.now()): string {
  const at = typeof input === "string" && /T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input) ? Date.parse(input) : NaN;
  if (!Number.isFinite(at) || at < now + 120_000 || at > now + 365 * 24 * 60 * 60_000) {
    throw new HttpError(400, "Choose a time between two minutes and one year from now.");
  }
  return new Date(Math.ceil(at / 1000) * 1000).toISOString();
}

export function markdownWithImages(draft: Draft, urls: Record<string, string>) {
  return draftMarkdown(draft.fields, urls, draft.kind === "longform");
}

export function longformFields(draft: Draft, content: string) {
  const { title, slug, excerpt, tags, teaser, syndicate, video, managedLaunch } = draft.fields;
  return {
    title: title.trim(), slug: safeSlug(slug || title), content, excerpt: excerpt.trim(), tags,
    syndicationTeaser: teaser.trim(), syndicate,
    ...(video && { video }),
    ...(managedLaunch && { managedLaunch: true }),
  };
}
