/** Typed client for the optional editor on a Serverless Social deployment. */
export type PostKind = "post" | "longform";
export type DraftFields = {
  content: string;
  title: string;
  slug: string;
  excerpt: string;
  tags: string[];
  teaser: string;
  syndicate: boolean;
  images: { id: string; alt: string }[];
};

export type EditorDraft = {
  id: string;
  did: string;
  kind: PostKind;
  version: number;
  state: "draft" | "scheduled" | "publishing" | "published" | "failed";
  fields: DraftFields;
  updatedAt: string;
  scheduledAt?: string;
  shareUrl?: string;
  previews?: Record<string, string>;
  sourceRkey?: string;
  result?: { uri: string; cid: string; rkey: string };
  error?: string;
};

export type DraftSummary = Pick<EditorDraft, "id" | "kind" | "state" | "updatedAt" | "scheduledAt">
  & { title: string };

export function emptyDraftFields(): DraftFields {
  return { content: "", title: "", slug: "", excerpt: "", tags: [], teaser: "", syndicate: true, images: [] };
}

function imageLabel(alt: string) {
  return alt.replace(/[\[\]\\\n\r]/g, " ");
}

/** Resolve editor-only image markers and append attached images without an inline position. */
export function draftMarkdown(fields: DraftFields, urls: Record<string, string>, includeContent = true): string {
  const images = new Map(fields.images.map(image => [image.id, image.alt]));
  const placed = new Set<string>();
  const body = includeContent ? fields.content.replace(
    /!\[[^\]]*\]\(draft-image:([\w-]+)\)/g,
    (marker, id: string) => {
      if (!images.has(id) || !Object.hasOwn(urls, id)) return marker;
      placed.add(id);
      return `![${imageLabel(images.get(id)!)}](${urls[id]})`;
    },
  ).replace(/draft-image:([\w-]+)/g, (marker, id: string) => {
    if (!images.has(id) || !Object.hasOwn(urls, id)) return marker;
    placed.add(id);
    return urls[id];
  }) : "";
  const extra = fields.images.filter(({ id }) => !placed.has(id) && Object.hasOwn(urls, id))
    .map(({ id, alt }) => `![${imageLabel(alt)}](${urls[id]})`);
  return [body, ...extra].filter(Boolean).join("\n\n");
}

export class EditorError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createEditorClient(options: {
  origin: string;
  did: string;
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}) {
  const root = options.origin.replace(/\/$/, "") + "/auth/editor";
  const send = options.fetch ?? fetch;
  async function request<T>(suffix = "", method = "GET", payload?: object | Blob): Promise<T> {
    const token = await options.token();
    if (!token) throw new EditorError(401, "Sign in to use the editor.");
    const binary = payload instanceof Blob;
    const path = `${root}${suffix}${suffix.includes("?") ? "&" : "?"}did=${encodeURIComponent(options.did)}`;
    const response = await send(path, {
      method, headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { "Content-Type": binary ? payload.type : "application/json" } : {}),
      },
      ...(payload ? { body: binary ? payload : JSON.stringify(payload) } : {}),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => null);
    if (!response.ok || data === null) {
      throw new EditorError(response.status, data?.message ?? "The editor is unavailable.");
    }
    return data as T;
  }
  const item = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    identities: () => request<{ identities: { did: string; handle: string }[] }>("/identities"),
    list: (after?: string) => request<{ drafts: DraftSummary[]; cursor?: string }>(
      after ? `?after=${encodeURIComponent(after)}` : ""),
    published: (kind: PostKind, after?: string) => request<{
      posts: { rkey: string; title: string; createdAt?: string }[]; cursor?: string;
    }>(`/published?kind=${kind}${after ? `&after=${encodeURIComponent(after)}` : ""}`),
    create: (kind: PostKind, rkey?: string) => request<EditorDraft>("", "POST", { kind, rkey }),
    get: (id: string) => request<EditorDraft>(item(id)),
    copy: (id: string, version: number, targetDid: string, requestId: string) =>
      request<EditorDraft>(`${item(id)}/copy`, "POST", { version, targetDid, requestId }),
    save: (id: string, version: number, fields: DraftFields) =>
      request<EditorDraft>(item(id), "PUT", { version, fields }),
    remove: (id: string, version: number) =>
      request<void>(`${item(id)}?version=${version}`, "DELETE"),
    upload: (id: string, version: number, file: Blob) =>
      request<EditorDraft>(`${item(id)}/media?version=${version}`, "POST", file),
    share: (id: string, version: number, enabled: boolean) =>
      request<EditorDraft>(`${item(id)}/share`, "POST", { version, enabled }),
    schedule: (id: string, version: number, at: string) =>
      request<EditorDraft>(`${item(id)}/schedule`, "POST", { version, at }),
    cancel: (id: string, version: number) =>
      request<EditorDraft>(`${item(id)}/cancel`, "POST", { version }),
    publish: (id: string, version: number) =>
      request<EditorDraft>(`${item(id)}/publish`, "POST", { version }),
  };
}
