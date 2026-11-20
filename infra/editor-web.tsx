export { PublishingCalendar } from "./publishing-calendar-web";
import {
  useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode,
} from "react";
import { createEditorClient, draftMarkdown, insertDraftImage, type DraftFields, type DraftSummary, type EditorDraft, type PostKind } from "./editor";
import { normalizeVideoCompanion, videoTitleLimit } from "./youtube";

type Client = ReturnType<typeof createEditorClient>;
type Published = Awaited<ReturnType<Client["published"]>>["posts"];

export interface PostEditorProps {
  client: Client;
  identity: string;
  initialKind?: PostKind;
  initialDraftId?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onPublished?: (post: NonNullable<EditorDraft["result"]>, kind: PostKind) => void;
  onPlanLaunch?: (post: NonNullable<EditorDraft["result"]>) => void;
  renderMarkdown?: (source: string) => ReactNode;
  accent?: string;
}

const css = `
.ss-editor{box-sizing:border-box;width:100%;max-width:54rem;margin:auto;padding:clamp(1rem,4vw,2.5rem);color:var(--ss-editor-text,#eef1f6);font:16px/1.5 system-ui,sans-serif}
.ss-editor h1{margin:0 0 .25rem;font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.1}
.ss-editor h2{font-size:1.15rem;margin:.75rem 0}.ss-editor p{margin:.4rem 0 .9rem}
.ss-editor .ss-row{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin:.85rem 0}
.ss-editor label{display:grid;gap:.35rem;margin:.8rem 0}.ss-editor fieldset{border:0;padding:0;margin:0;min-width:0}
.ss-editor input,.ss-editor textarea,.ss-editor button{font:inherit;color:inherit;color-scheme:dark}
.ss-editor input:not([type=checkbox]),.ss-editor textarea,.ss-editor button{border:1px solid #354157;border-radius:.5rem;background:#17202e;padding:.55rem .8rem}
.ss-editor textarea,.ss-editor input:not([type=checkbox]){width:100%;box-sizing:border-box}
.ss-editor textarea{resize:vertical;min-height:8rem}
.ss-editor button{cursor:pointer}.ss-editor button:disabled{cursor:default;opacity:.5}
.ss-editor button[aria-pressed=true],.ss-editor .ss-primary{border-color:var(--ss-editor-accent,#77aaff)}
.ss-editor a{color:var(--ss-editor-accent,#77aaff)}.ss-editor small,.ss-editor .ss-muted{color:#aeb8cb}
.ss-editor [role=alert]{color:#ff9d9d}.ss-editor img{max-width:100%;max-height:16rem;object-fit:contain;border-radius:.5rem}
.ss-editor .ss-asset,.ss-editor .ss-preview{padding:1rem;border:1px solid #354157;border-radius:.6rem;margin:1rem 0}
.ss-editor .ss-video{margin:1.2rem 0}
.ss-editor .ss-video h2{margin-bottom:.25rem}
.ss-editor .ss-video-preview{margin-top:1rem;padding:1rem;border:1px solid #354157;border-radius:.5rem}
.ss-editor .ss-video-preview strong,.ss-editor .ss-video-preview a{display:block}
.ss-editor .ss-item{width:100%;text-align:left;margin:.25rem 0;overflow-wrap:anywhere}
.ss-editor .ss-status{min-height:1.5em}.ss-editor .ss-preview{overflow-wrap:anywhere}.ss-editor .ss-plain{white-space:pre-wrap}

.ss-editor.ss-editor--article{max-width:82rem;container:ss-editor / inline-size}
.ss-editor .ss-draft-header,.ss-editor .ss-draft-fields{width:100%;max-width:49rem;margin-inline:auto}
.ss-editor .ss-draft-writing,.ss-editor .ss-draft-details{min-width:0;display:flow-root}
.ss-editor .ss-draft-fields .ss-preview{display:none}
.ss-editor .ss-draft-fields .ss-preview--open{display:block}
.ss-editor .ss-preview-heading{margin:0 0 .8rem;font-size:.9rem;font-weight:650;color:#aeb8cb;padding-bottom:.6rem;border-bottom:1px solid #354157}
.ss-editor .ss-preview-title{margin:.2rem 0 .9rem;font-size:1.55rem;line-height:1.2}
.ss-editor .ss-preview pre{overflow:auto;max-width:100%}
@container ss-editor (min-width:60rem){
  .ss-editor--article .ss-draft-header,.ss-editor--article .ss-draft-fields{max-width:none}
  .ss-editor--article .ss-draft-layout{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,1fr);column-gap:1.75rem;align-items:start}
  .ss-editor--article .ss-draft-writing{grid-area:1/1}
  .ss-editor--article .ss-draft-details{grid-area:2/1}
  .ss-editor--article .ss-draft-fields .ss-preview{display:block;grid-area:1/2/span 2;position:sticky;top:.75rem;min-width:0;margin:.8rem 0 0}
  .ss-editor--article .ss-preview-body{max-height:min(68vh,46rem);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
  .ss-editor--article .ss-preview-body:focus-visible{outline:2px solid var(--ss-editor-accent,#77aaff);outline-offset:-2px;border-radius:.25rem}
  .ss-editor--article .ss-preview-toggle{display:none}
  .ss-editor--article .ss-draft-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:.85rem}
  .ss-editor--article .ss-draft-writing textarea{min-height:19rem}
}
`;

/** Reusable authoring UI for a web app that already supplies an authenticated editor client. */
export function PostEditor({ client, identity, initialKind = "post", initialDraftId, onDirtyChange, onPublished, onPlanLaunch, renderMarkdown, accent }: PostEditorProps) {
  const [draft, setDraft] = useState<EditorDraft>();
  const [fields, setFields] = useState<DraftFields>();
  const [tagText, setTagText] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [videoTouched, setVideoTouched] = useState(false);
  const videoFieldId = useId();
  const previewId = useId();
  const validVideo = normalizeVideoCompanion({ url: videoUrl, title: videoTitle });
  const invalidVideo = draft?.kind === "longform" && !!videoUrl.trim() && !validVideo;
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [published, setPublished] = useState<Published>([]);
  const [tab, setTab] = useState<"drafts" | "published">("drafts");
  const [kind, setKind] = useState<PostKind>(initialKind);
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [scheduleAt, setScheduleAt] = useState("");
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const latest = useRef<{ draft?: EditorDraft; fields?: DraftFields }>({});
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const bodyCursor = useRef<number>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const foreground = useRef(false);
  const hasUnsavedChanges = !!draft && !!fields && (fields !== draft.fields || invalidVideo);
  useEffect(() => { onDirtyChange?.(hasUnsavedChanges); }, [hasUnsavedChanges, onDirtyChange]);

  const showError = (reason: unknown) => setError(reason instanceof Error ? reason.message : "The editor is unavailable.");

  const open = useCallback((next?: EditorDraft) => {
    latest.current = { draft: next, fields: next?.fields };
    bodyCursor.current = undefined;
    setDraft(next);
    setFields(next?.fields);
    setTagText(next?.fields.tags.join(", ") ?? "");
    setVideoUrl(next?.fields.video?.url ?? "");
    setVideoTitle(next?.fields.video?.title ?? "");
    setVideoTouched(false);
    setPreview(false);
    setCopied(false);
    setScheduleAt("");
  }, []);

  useEffect(() => {
    if (!initialDraftId) return;
    let active = true;
    setBusy(true);
    setError(undefined);
    void client.get(initialDraftId).then(next => {
      if (!active) return;
      setKind(next.kind);
      open(next);
    }).catch(reason => { if (active) showError(reason); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [client, initialDraftId, open]);

  const refresh = useCallback(async (after?: string) => {
    if (tab === "drafts") {
      const result = await client.list(after);
      setDrafts(previous => [...(after ? previous : []), ...result.drafts]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setCursor(result.cursor);
    } else {
      const result = await client.published(kind, after);
      setPublished(previous => [...(after ? previous : []), ...result.posts]);
      setCursor(result.cursor);
    }
  }, [client, tab, kind]);

  useEffect(() => {
    if (draft) return;
    setCursor(undefined);
    void refresh().catch(showError);
  }, [draft, refresh]);

  const flush = useCallback(async () => {
    const current = latest.current;
    if (!current.draft || !current.fields || current.fields === current.draft.fields) return current.draft;
    setSaving(true);
    try {
      const next = await client.save(current.draft.id, current.draft.version, current.fields);
      const unchangedDuringSave = latest.current.fields === current.fields;
      const kept = unchangedDuringSave ? next.fields : latest.current.fields;
      latest.current = { draft: next, fields: kept };
      setDraft(next);
      if (unchangedDuringSave) setFields(next.fields);
      return next;
    } finally {
      setSaving(false);
    }
  }, [client]);

  const serialize = useCallback((action: () => Promise<void>) => {
    const job = queue.current.then(action);
    queue.current = job.catch(() => undefined);
    return job;
  }, []);

  useEffect(() => {
    if (!draft || !fields || fields === draft.fields || busy) return;
    const timer = setTimeout(() => {
      void serialize(async () => { await flush(); }).catch(showError);
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, fields, busy, flush, serialize]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!draft || (draft.state !== "publishing" && draft.state !== "scheduled")) return;
    const refreshStatus = () => {
      if (foreground.current || latest.current.fields !== latest.current.draft?.fields) return;
      void serialize(async () => {
        const current = latest.current.draft;
        if (!current || current.id !== draft.id || latest.current.fields !== current.fields) return;
        if (current.scheduledAt && Date.now() + 3000 < Date.parse(current.scheduledAt)) return;
        const next = await client.get(draft.id);
        if (next.version !== current.version) {
          latest.current = { draft: next, fields: next.fields };
          setDraft(next);
          setFields(next.fields);
        }
      }).catch(showError);
    };
    const timer = setInterval(refreshStatus, 2500);
    return () => clearInterval(timer);
  }, [client, draft, serialize]);

  function change(patch: Partial<DraftFields>) {
    if (!latest.current.fields) return;
    const next = { ...latest.current.fields, ...patch };
    latest.current = { ...latest.current, fields: next };
    setFields(next);
    setError(undefined);
  }

  function changeVideo(url: string, title: string) {
    const next = normalizeVideoCompanion({ url, title });
    if (url.trim() && !next) return;
    const previous = latest.current.fields?.video;
    if (previous?.url !== next?.url || previous?.title !== next?.title) change({ video: next });
  }

  function run(action: () => Promise<void>) {
    if (foreground.current) return;
    foreground.current = true;
    setBusy(true);
    setError(undefined);
    void serialize(action).catch(showError).finally(() => {
      foreground.current = false;
      setBusy(false);
    });
  }

  function mutate(action: (active: EditorDraft) => Promise<EditorDraft>) {
    run(async () => {
      const active = await flush();
      if (active) {
        const next = await action(active);
        // Keep the local tag and schedule fields while the result is applied.
        latest.current = { draft: next, fields: next.fields };
        setDraft(next);
        setFields(next.fields);
      }
    });
  }

  const style = { "--ss-editor-accent": accent } as CSSProperties;
  if (!draft || !fields) {
    return (
      <section className="ss-editor" style={style} aria-labelledby="ss-editor-title">
        <style>{css}</style>
        <h1 id="ss-editor-title">Post editor</h1>
        <p className="ss-muted">Writing as @{identity}</p>
        <div className="ss-row">
          <button type="button" className="ss-primary" disabled={busy} onClick={() => run(async () => open(await client.create("post")))}>New post</button>
          <button type="button" className="ss-primary" disabled={busy} onClick={() => run(async () => open(await client.create("longform")))}>New article</button>
        </div>
        <div className="ss-row">
          <button type="button" aria-pressed={tab === "drafts"} onClick={() => setTab("drafts")}>Drafts and scheduled</button>
          <button type="button" aria-pressed={tab === "published"} onClick={() => setTab("published")}>Published</button>
        </div>
        {error && <p role="alert">{error}</p>}
        {tab === "drafts" ? (
          drafts.filter(item => item.state !== "published").map(item => (
            <button className="ss-item" key={item.id} disabled={busy} type="button"
              onClick={() => run(async () => open(await client.get(item.id)))}>
              {item.title || (item.kind === "post" ? "Untitled post" : "Untitled article")}
              <small> · {item.state}{item.scheduledAt ? ` · ${new Date(item.scheduledAt).toLocaleString()}` : ""}</small>
            </button>
          ))
        ) : (
          <>
            <div className="ss-row">
              <button type="button" aria-pressed={kind === "post"} onClick={() => setKind("post")}>Posts</button>
              <button type="button" aria-pressed={kind === "longform"} onClick={() => setKind("longform")}>Articles</button>
            </div>
            {published.map(item => (
              <button className="ss-item" key={item.rkey} disabled={busy} type="button"
                onClick={() => run(async () => open(await client.create(kind, item.rkey)))}>
                {item.title || "Image post"}{item.createdAt && <small> · {new Date(item.createdAt).toLocaleDateString()}</small>}
              </button>
            ))}
          </>
        )}
        {cursor && <button type="button" disabled={busy} onClick={() => run(() => refresh(cursor))}>Load more</button>}
      </section>
    );
  }

  const longform = draft.kind === "longform";
  const locked = ["publishing", "published"].includes(draft.state);
  const dirty = fields !== draft.fields;
  const label = longform ? "article" : "post";
  return (
    <section className={longform && !locked ? "ss-editor ss-editor--article" : "ss-editor"} style={style} aria-labelledby="ss-editor-title">
      <style>{css}</style>
      <div className="ss-draft-header">
        <button type="button" disabled={busy} onClick={() => run(async () => { await flush(); open(); })}>Back to posts and drafts</button>
        <div className="ss-row"><h1 id="ss-editor-title">{draft.sourceRkey ? "Edit" : "Draft"} {label}</h1></div>
        <div className="ss-status" aria-live="polite">
          {draft.state === "publishing" ? "Publishing…" : draft.state === "published" ? "Published"
            : saving ? "Saving…" : dirty ? "Unsaved changes" : draft.scheduledAt ? `Scheduled for ${new Date(draft.scheduledAt).toLocaleString()}` : "Draft saved"}
      </div>
        {(error || draft.error) && <p role="alert">{error ?? draft.error}</p>}
        {draft.state === "published" && draft.result && (
          <button className="ss-primary" type="button" onClick={() => onPublished?.(draft.result!, draft.kind)}>View published {label}</button>
        )}
        {draft.state === "published" && draft.result && draft.fields.managedLaunch && onPlanLaunch && (
          <button type="button" onClick={() => onPlanLaunch(draft.result!)}>Plan social launch</button>
        )}
      </div>
      {!locked && <fieldset className="ss-draft-fields" disabled={busy}>
        <div className="ss-draft-layout">
          <div className="ss-draft-writing">
            {longform && <>
              <label>Title<input value={fields.title} onChange={event => change({ title: event.target.value })} /></label>
              <div className="ss-draft-metadata">
                <label>URL slug<input value={fields.slug} placeholder="Generated from the title" onChange={event => change({ slug: event.target.value })} /></label>
                <label>Tags, separated by commas<input value={tagText} onChange={event => {
                  setTagText(event.target.value);
                  change({ tags: event.target.value.split(",").map(tag => tag.trim()).filter(Boolean).slice(0, 12) });
                }} /></label>
              </div>
              <label>Excerpt<input value={fields.excerpt} onChange={event => change({ excerpt: event.target.value })} /></label>
            </>}
            <label>{longform ? "Article body (Markdown)" : "Post text"}<textarea ref={bodyInput} rows={longform ? 14 : 5}
              value={fields.content} onChange={event => change({ content: event.target.value })}
              onSelect={event => { bodyCursor.current = event.currentTarget.selectionEnd; }} />
            </label>
            {!longform && <small>{[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(fields.content)].length}/300 characters</small>}
            {longform && <section className="ss-video" aria-labelledby={`${videoFieldId}-title`}>
              <h2 id={`${videoFieldId}-title`}>Video companion</h2>
              <small id={`${videoFieldId}-help`}>Optional. Readers open the video on YouTube.</small>
              <label>YouTube video link
                <input type="url" value={videoUrl} placeholder="https://youtu.be/…" maxLength={2048} autoComplete="off"
                  aria-describedby={`${videoFieldId}-help${invalidVideo && videoTouched ? ` ${videoFieldId}-error` : ""}`}
                  aria-invalid={invalidVideo && videoTouched ? true : undefined}
                  onChange={event => {
                    const url = event.currentTarget.value;
                    setVideoUrl(url);
                    changeVideo(url, videoTitle);
                  }}
                  onBlur={() => {
                    setVideoTouched(true);
                    if (validVideo) setVideoUrl(validVideo.url);
                  }} />
              </label>
              {invalidVideo && videoTouched && <p id={`${videoFieldId}-error`} role="alert">Enter an HTTPS link to a YouTube video or clear this field.</p>}
              {validVideo && <label>Video title (optional)
                <input value={videoTitle} maxLength={videoTitleLimit} onChange={event => {
                  const title = event.currentTarget.value;
                  setVideoTitle(title);
                  changeVideo(videoUrl, title);
                }} />
              </label>}
              {(videoUrl || fields.video) && <button type="button" onClick={() => {
                setVideoUrl("");
                setVideoTitle("");
                setVideoTouched(false);
                changeVideo("", "");
              }}>Remove video</button>}
            </section>}
            <div className="ss-row">
              <button className="ss-preview-toggle" type="button" aria-expanded={preview} aria-controls={previewId}
                onClick={() => setPreview(!preview)}>{preview ? "Hide preview" : "Preview"}</button>
              <button type="button" disabled={!dirty} onClick={() => run(async () => { await flush(); })}>Save draft</button>
          </div>
          </div>
          <section id={previewId} className={preview ? "ss-preview ss-preview--open" : "ss-preview"} aria-labelledby={`${previewId}-heading`}>
            <h2 id={`${previewId}-heading`} className="ss-preview-heading">{longform ? "Live preview" : "Post preview"}</h2>
            <div className="ss-preview-body" role={longform ? "region" : undefined} aria-label={longform ? "Preview content" : undefined}
              tabIndex={longform ? 0 : undefined}>
              {longform && fields.title && <h3 className="ss-preview-title">{fields.title}</h3>}
              {fields.content || !longform
                ? longform && renderMarkdown ? renderMarkdown(draftMarkdown(fields, draft.previews ?? {})) : <p className="ss-plain">{fields.content}</p>
                : <p className="ss-muted">Start writing to preview your Markdown.</p>}
              {longform && validVideo && <aside className="ss-video-preview" aria-label="Video companion">
                <small>Video companion</small>
                {validVideo.title && <strong>{validVideo.title}</strong>}
                <a href={validVideo.url} target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
              </aside>}
              {!longform && preview && fields.images.map(image => <img key={image.id} src={draft.previews?.[image.id]} alt={image.alt} />)}
            </div>
          </section>
          <div className="ss-draft-details">
            <label>Upload image (PNG, JPEG, or WebP, up to 1 MB)
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={fields.images.length >= 4}
                onChange={event => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) {
                    if (file.size > 1_000_000) setError("Use an image up to 1 MB.");
                    else mutate(active => client.upload(active.id, active.version, file));
                  }
                }} />
            </label>
            {fields.images.map(image => (
              <div className="ss-asset" key={image.id}>
                <img src={draft.previews?.[image.id]} alt={image.alt} />
                <label>Alt text<input value={image.alt} onChange={event =>
                  change({ images: fields.images.map(item => item.id === image.id ? { ...item, alt: event.target.value } : item) })
                } /></label>
                <div className="ss-row">
                  {longform && <button type="button" onClick={() => {
                    const inserted = insertDraftImage(fields.content, image, bodyCursor.current);
                    change({ content: inserted.content });
                    requestAnimationFrame(() => {
                      bodyInput.current?.focus();
                      bodyInput.current?.setSelectionRange(inserted.cursor, inserted.cursor);
                    });
                  }}>Insert into article</button>}
                  <button type="button" onClick={() => change({
                    images: fields.images.filter(item => item.id !== image.id),
                    content: fields.content.replace(
                      new RegExp(`!\\[[^\\]]*\\]\\(draft-image:${image.id}\\)`, "g"), "",
                    ).replaceAll(`draft-image:${image.id}`, ""),
                  })}>Remove image</button>
                </div>
              </div>
            ))}
            {longform && <>
              {!draft.sourceRkey && <label>
                <span><input type="checkbox" checked={!!fields.managedLaunch}
                  onChange={event => change({ managedLaunch: event.target.checked })} /> Plan the social launch separately</span>
                <small>Publish the article first, then write and schedule its Bluesky and ActivityPub announcements from Launches.</small>
              </label>}
              {fields.managedLaunch
                ? draft.sourceRkey && <p className="ss-muted">Manage the social announcements for this article in Launches.</p>
                : <>
                  <label><span><input type="checkbox" checked={fields.syndicate} onChange={event => change({ syndicate: event.target.checked })} /> Syndicate to Bluesky when published</span></label>
                  {fields.syndicate && <label>Bluesky teaser<input value={fields.teaser} onChange={event => change({ teaser: event.target.value })} /></label>}
                </>}
            </>}
            <h2>Visibility</h2>
            <p className="ss-muted">{draft.sourceRkey ? "Your revision is private until you publish it. The previous version stays public."
              : "This draft is private until you share a preview link or publish it."}</p>
            {draft.shareUrl ? <>
              <div className="ss-row">
                <a href={draft.shareUrl} target="_blank" rel="noreferrer">Open unlisted preview</a>
                {typeof navigator !== "undefined" && navigator.clipboard && <button type="button" onClick={() => {
                  void navigator.clipboard.writeText(draft.shareUrl!).then(() => setCopied(true)).catch(showError);
                }}>{copied ? "Copied" : "Copy preview link"}</button>}
                <button type="button" onClick={() => mutate(active => client.share(active.id, active.version, false))}>Revoke link</button>
              </div>
            </> : <button type="button" onClick={() => mutate(active => client.share(active.id, active.version, true))}>Create unlisted preview link</button>}
            <h2>Publish</h2>
            <label>Scheduled time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              <input type="datetime-local" value={scheduleAt} onChange={event => setScheduleAt(event.target.value)} />
            </label>
            <div className="ss-row">
              <button type="button" className="ss-primary" disabled={invalidVideo} onClick={() => mutate(active => client.publish(active.id, active.version))}>Publish now</button>
              <button type="button" disabled={!scheduleAt || invalidVideo} onClick={() => mutate(active =>
                client.schedule(active.id, active.version, new Date(scheduleAt).toISOString()))}>{draft.scheduledAt ? "Reschedule" : "Schedule"}</button>
              {draft.scheduledAt && <button type="button" onClick={() => mutate(active => client.cancel(active.id, active.version))}>Cancel schedule</button>}
            </div>
            <button type="button" onClick={() => {
              if (window.confirm(`Delete this ${draft.scheduledAt ? "scheduled " : ""}draft?`)) {
                run(async () => {
                  const active = latest.current.draft;
                  if (active) await client.remove(active.id, active.version);
                  open();
                });
              }
            }}>Delete draft</button>
          </div>
        </div>
      </fieldset>}
    </section>
  );
}
