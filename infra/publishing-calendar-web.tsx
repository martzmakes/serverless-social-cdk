import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createEditorClient, type DraftSummary, type EditorIdentity, type PostKind } from "./editor";

type Identity = EditorIdentity & { host?: string };
type Client = ReturnType<typeof createEditorClient>;
type Entry = { draft: DraftSummary; identity: Identity };
type DraftPage = { drafts: DraftSummary[]; cursor?: string; error?: string };

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: ".75rem" };
const states = { draft: "Draft", scheduled: "Scheduled", publishing: "Publishing", published: "Published", failed: "Failed" };
const formats = { longform: "Articles", post: "Short posts" } as const;
const libraryCss = `
.ss-library{font:1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
.ss-library h1{font-size:clamp(1.8rem,4vw,3rem);line-height:1.1;letter-spacing:-.04em;margin:.1rem 0 .8rem}
.ss-library h2{margin:.2rem 0 .65rem;font-size:1.15rem}
.ss-library .ss-library-row{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem .65rem;margin-block:.7rem}
.ss-library label{font-size:.875rem}
.ss-library button,.ss-library select,.ss-library input{font:inherit;color:inherit;border:1px solid var(--mw-line,#435672);border-radius:.45rem;background:var(--mw-card,#172437);padding:.42rem .6rem}
.ss-library button{cursor:pointer}.ss-library button:disabled{opacity:.55;cursor:default}
.ss-library button[aria-pressed=true]{background:#243852;border-color:#769cc8}
.ss-library input[type=search]{min-width:0;width:min(100%,19rem)}
.ss-library ol,.ss-library ul{list-style:none;margin:0;padding:0}
.ss-library .ss-library-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.7rem;align-items:start}
.ss-library .ss-library-panel{min-width:0;padding:.85rem;border:1px solid var(--mw-line,#425570);border-radius:.65rem;background:var(--mw-card,#141f30)}
.ss-library .ss-library-panel a{color:var(--mw-accent,#bbd8ff)}
.ss-library .ss-library-panel small,.ss-library .ss-library-caption{color:var(--mw-muted,#bac9dc)}
.ss-library .ss-library-published{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4rem .9rem;align-items:center;padding:.6rem 0;border-bottom:1px solid var(--mw-line,#425570)}
.ss-library .ss-library-published:last-child{border-bottom:0}
.ss-library .ss-library-published strong,.ss-library .ss-library-published small{display:block}
.ss-library .ss-library-board .ss-library-published{display:block}
@media(max-width:990px){.ss-library .ss-library-board{grid-template-columns:1fr}}
@media(max-width:560px){.ss-library .ss-library-published{display:block}.ss-library .ss-library-published .ss-library-row{margin-block:.4rem}}
`;

type LibraryStatus = "published" | "draft" | "scheduled";
type PublishedItem = Awaited<ReturnType<Client["published"]>>["posts"][number] & { kind: PostKind };
type LibraryProps = {
  origin: string; token: () => Promise<string | null>; preferredHost: string; initialStatus?: LibraryStatus;
  onOpen: (draft: Pick<DraftSummary, "id" | "kind">, did: string, host?: string) => void;
  publishedHref: (kind: PostKind, rkey: string, identity: EditorIdentity) => string;
  onAnalytics?: (did: string, rkey: string) => void;
  onNew: (kind: PostKind) => void;
};

export function PublishingLibrary({ origin, token, preferredHost, initialStatus, onOpen, publishedHref, onNew, onAnalytics }: LibraryProps) {
  const [identities, setIdentities] = useState<Identity[]>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    setIdentities(undefined);
    void createEditorClient({ origin, did: "", token }).identities().then(({ identities }) => {
      if (!active) return;
      setIdentities(identities);
      setSelected((identities.find(item => item.handle === preferredHost) ?? identities[0])?.did ?? "");
    }).catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [origin, token, preferredHost, retry]);
  const identity = identities?.find(item => item.did === selected);
  return <section className="ss-library" aria-label="Publishing">
    <style>{libraryCss}</style>
    <h1>Publishing</h1>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>
      : !identities ? <p role="status">Loading publishing identities…</p>
      : !identity ? <p>No publishing identity is available.</p> : <>
        <div className="ss-library-row">
          <label>Site{" "}<select value={selected} onChange={event => setSelected(event.target.value)}>
            {identities.map(item => <option key={item.did} value={item.did}>{item.handle}</option>)}
          </select></label>
          {identity.handle === preferredHost && <>
            <button type="button" onClick={() => onNew("longform")}>New article</button>
            <button type="button" onClick={() => onNew("post")}>New short post</button>
          </>}
        </div>
        <LibrarySite key={`${identity.did}:${initialStatus ?? "published"}`} {...{ origin, token, identity, initialStatus, onOpen, publishedHref, onAnalytics }}
          targets={identity.copyTargets ?? identities.filter(item => item.did !== identity.did)} />
      </>}
  </section>;
}

function LibrarySite({ origin, token, identity, initialStatus = "published", targets, onOpen, publishedHref, onAnalytics }: Pick<LibraryProps,
  "origin" | "token" | "initialStatus" | "onOpen" | "publishedHref" | "onAnalytics"> & { identity: Identity; targets: Identity[] }) {
  const client = useMemo(() => createEditorClient({ origin, did: identity.did, token }), [origin, identity.did, token]);
  const [mode, setMode] = useState<"library" | "board">("library");
  const [status, setStatus] = useState<LibraryStatus>(initialStatus);
  const [kind, setKind] = useState<PostKind | "all">("longform");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [posts, setPosts] = useState<PublishedItem[]>([]);
  const [cursors, setCursors] = useState<Partial<Record<"drafts" | PostKind, string>>>({});
  const [loaded, setLoaded] = useState<Partial<Record<"drafts" | PostKind, boolean>>>({});
  const [pending, setPending] = useState<Partial<Record<"drafts" | PostKind, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<"drafts" | PostKind, string>>>({});
  const [editError, setEditError] = useState("");
  const [editing, setEditing] = useState<string>();
  const active = useRef(true);
  const reading = useRef(new Set<"drafts" | PostKind>());
  const editLock = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const load = useCallback(async (page: "drafts" | PostKind, after?: string) => {
    if (reading.current.has(page)) return;
    reading.current.add(page);
    setPending(previous => ({ ...previous, [page]: true }));
    setErrors(previous => ({ ...previous, [page]: undefined }));
    try {
      if (page === "drafts") {
        const result = await client.list(after);
        if (!active.current) return;
        setDrafts(previous => [...new Map([...(after ? previous : []), ...result.drafts].map(item => [item.id, item])).values()]);
        setCursors(previous => ({ ...previous, drafts: result.cursor === after ? undefined : result.cursor }));
      } else {
        const result = await client.published(page, after);
        if (!active.current) return;
        setPosts(previous => [...new Map([...previous.filter(item => after || item.kind !== page),
          ...result.posts.map(item => ({ ...item, kind: page }))].map(item => [`${item.kind}:${item.rkey}`, item])).values()]);
        setCursors(previous => ({ ...previous, [page]: result.cursor === after ? undefined : result.cursor }));
      }
    } catch (error) {
      if (active.current) setErrors(previous => ({ ...previous, [page]: errorMessage(error) }));
    } finally {
      reading.current.delete(page);
      if (active.current) {
        setPending(previous => ({ ...previous, [page]: false }));
        setLoaded(previous => ({ ...previous, [page]: true }));
      }
    }
  }, [client]);
  const visibleKinds = kind === "all" ? ["longform", "post"] as const : [kind];
  const showPublished = mode === "board" || status === "published";
  const showDrafts = mode === "board" || status !== "published";
  useEffect(() => {
    if (showDrafts && !loaded.drafts) void load("drafts");
    if (showPublished && kind !== "post" && !loaded.longform) void load("longform");
    if (showPublished && kind !== "longform" && !loaded.post) void load("post");
  }, [showDrafts, showPublished, kind, loaded, load]);

  const matches = (title: string) => !search.trim() || title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const matchingDrafts = drafts.filter(item => item.state !== "published" && (kind === "all" || item.kind === kind) && matches(item.title || ""));
  const scheduled = matchingDrafts.filter(item => item.state === "scheduled").sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
  const unscheduled = matchingDrafts.filter(item => item.state !== "scheduled").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const published = posts.filter(item => (kind === "all" || kind === item.kind) && matches(item.title || "Media post"))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  async function revise(item: PublishedItem) {
    if (editLock.current) return;
    editLock.current = true;
    setEditing(`${item.kind}:${item.rkey}`);
    setEditError("");
    try {
      const created = await client.create(item.kind, item.rkey);
      if (active.current) onOpen(created, identity.did);
    } catch (error) {
      if (active.current) setEditError(errorMessage(error));
    } finally {
      editLock.current = false;
      if (active.current) setEditing(undefined);
    }
  }

  const renderDrafts = (items: DraftSummary[], empty: string) => items.length ? <ul>{items.map(draft =>
    <CalendarEntry key={draft.id} entry={{ draft, identity }} {...{ client, targets, onOpen }} />
  )}</ul> : <p>{pending.drafts ? "Loading…" : empty}</p>;
  const renderPublished = published.length ? <ul>{published.map(item => {
    const title = item.title || "Media post";
    return <li className="ss-library-published" key={`${item.kind}:${item.rkey}`}>
      <div><strong>{title}</strong><small>{item.kind === "longform" ? "Article" : "Short post"}{item.createdAt && Number.isFinite(Date.parse(item.createdAt)) ? ` · ${date.format(new Date(item.createdAt))}` : ""}</small></div>
      <div className="ss-library-row">
        <button type="button" aria-label={`Edit ${title}`} disabled={!!editing} onClick={() => void revise(item)}>
          {editing === `${item.kind}:${item.rkey}` ? "Opening…" : "Edit"}
        </button>
        <a href={publishedHref(item.kind, item.rkey, identity)} aria-label={`View ${title}`} target="_blank" rel="noreferrer">View</a>
        {item.kind === "longform" && onAnalytics && <button type="button" aria-label={`Analytics for ${title}`}
          onClick={() => onAnalytics(identity.did, item.rkey)}>Analytics</button>}
      </div>
    </li>;
  })}</ul> : <p>{visibleKinds.some(key => pending[key]) ? "Loading…" : "No published items on the loaded pages."}</p>;
  const pagination = (key: "drafts" | PostKind) => {
    const label = key === "drafts" ? "drafts and scheduled work" : formats[key].toLowerCase();
    return <div key={key} className="ss-library-row">
      {errors[key] && <span role="alert">{errors[key]}</span>}
      {(cursors[key] || errors[key]) && <button type="button" disabled={pending[key]} onClick={() => void load(key, cursors[key])}>
        {pending[key] ? "Loading…" : errors[key] ? `Retry ${label}` : `Load more ${label}`}
      </button>}
    </div>;
  };

  return <>
    <div className="ss-library-row">
      <div className="ss-library-row" role="group" aria-label="Publishing layout">
        <button type="button" aria-pressed={mode === "library"} onClick={() => setMode("library")}>Library</button>
        <button type="button" aria-pressed={mode === "board"} onClick={() => setMode("board")}>Board</button>
      </div>
      <label>Content format{" "}<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
        <option value="longform">Articles</option><option value="post">Short posts</option><option value="all">All formats</option>
      </select></label>
      <input type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label="Search loaded work" placeholder="Search loaded work" />
    </div>
    {mode === "library" && <div className="ss-library-row" role="group" aria-label="Publication status">
      {(["published", "draft", "scheduled"] as const).map(value => <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{value === "draft" ? "Drafts" : states[value]}</button>)}
    </div>}
    {editError && <p role="alert">{editError}</p>}
    <div className={mode === "board" ? "ss-library-board" : undefined}>
      {showDrafts && (mode === "board" || status === "draft") && <section className="ss-library-panel"><h2>Drafts and in progress</h2>
        {renderDrafts(unscheduled, "No drafts on the loaded pages.")}
        {mode === "library" && pagination("drafts")}
      </section>}
      {showDrafts && (mode === "board" || status === "scheduled") && <section className="ss-library-panel"><h2>Scheduled</h2>
        {renderDrafts(scheduled, "No scheduled work on the loaded pages.")}
        {pagination("drafts")}
      </section>}
      {showPublished && <section className="ss-library-panel"><h2>Published</h2>
        {renderPublished}{visibleKinds.map(pagination)}
      </section>}
    </div>
  </>;
}

function upcoming(entry: Entry) {
  return entry.draft.state === "scheduled" && !!entry.draft.scheduledAt;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Couldn't load drafts.";
}

export function PublishingCalendar({ origin, token, onOpen }: {
  origin: string;
  token: () => Promise<string | null>;
  onOpen: (draft: Pick<DraftSummary, "id" | "kind">, did: string, host?: string) => void;
}) {
  const clientFor = useCallback((did: string) => createEditorClient({ origin, did, token }), [origin, token]);
  const [identities, setIdentities] = useState<Identity[]>();
  const [pages, setPages] = useState<Record<string, DraftPage>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setError("");
    setIdentities(undefined);
    setPages({});
    setBusy({});
    void clientFor("").identities().then(({ identities }) => {
      if (!current) return;
      setIdentities(identities);
      for (const { did } of identities) {
        void clientFor(did).list().then(page => {
          if (current) setPages(previous => ({ ...previous, [did]: page }));
        }).catch(reason => {
          if (current) setPages(previous => ({ ...previous, [did]: { drafts: [], error: errorMessage(reason) } }));
        });
      }
    }).catch(reason => { if (current) setError(errorMessage(reason)); });
    return () => { current = false; };
  }, [clientFor, attempt]);

  const entries = useMemo(() => (identities ?? []).flatMap(identity =>
    (pages[identity.did]?.drafts ?? []).filter(draft => draft.state !== "published").map(draft => ({ draft, identity })),
  ), [identities, pages]);
  const scheduled = entries.filter(upcoming).sort((a, b) => a.draft.scheduledAt!.localeCompare(b.draft.scheduledAt!));
  const drafts = entries.filter(entry => !upcoming(entry)).sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt));
  const loading = identities?.some(identity => !pages[identity.did]);

  async function loadMore(did: string) {
    if (busy[did]) return;
    const after = pages[did]?.cursor;
    setBusy(previous => ({ ...previous, [did]: true }));
    try {
      const result = await clientFor(did).list(after);
      setPages(previous => {
        const drafts = new Map((after ? previous[did].drafts : []).map(draft => [draft.id, draft]));
        for (const draft of result.drafts) drafts.set(draft.id, draft);
        return { ...previous, [did]: { drafts: [...drafts.values()], cursor: result.cursor !== after ? result.cursor : undefined } };
      });
    } catch (reason) {
      setPages(previous => ({ ...previous, [did]: { ...previous[did], error: errorMessage(reason) } }));
    } finally {
      setBusy(previous => ({ ...previous, [did]: false }));
    }
  }

  const render = (entry: Entry) => <CalendarEntry
    key={`${entry.identity.did}:${entry.draft.id}`}
    entry={entry}
    targets={entry.identity.copyTargets ?? (identities ?? []).filter(identity => identity.did !== entry.identity.did)}
    client={clientFor(entry.identity.did)}
    onOpen={onOpen}
  />;

  return (
    <section aria-label="Publishing calendar" style={{ maxWidth: 880, margin: "auto", padding: "clamp(1rem, 4vw, 2rem)", overflowWrap: "anywhere" }}>
      <h1 style={{ marginTop: 0 }}>Publishing calendar</h1>
      {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : !identities ? (
        <p role="status">Loading publishing identities…</p>
      ) : !identities.length ? <p>This account has no publishing identity.</p> : (
        <>
          <h2>Scheduled</h2>
          {scheduled.length ? <ul>{scheduled.map(render)}</ul> : <p>{loading ? "Loading schedules…" : "No scheduled posts on the loaded pages."}</p>}
          <h2>Drafts and in progress</h2>
          {drafts.length ? <ul>{drafts.map(render)}</ul> : <p>{loading ? "Loading drafts…" : "No drafts on the loaded pages."}</p>}
          {identities.map(({ did, handle }) => {
            const page = pages[did];
            if (!page) return <p key={did} role="status">Loading {handle}…</p>;
            if (page.error) return <p key={did} role="alert">{handle} · {page.error} <button disabled={busy[did]} onClick={() => void loadMore(did)}>Retry</button></p>;
            if (!page.cursor) return null;
            return <button key={did} disabled={busy[did]} onClick={() => void loadMore(did)}>Load more from {handle}</button>;
          })}
        </>
      )}
    </section>
  );
}

function CalendarEntry({ entry, targets, client, onOpen }: {
  entry: Entry;
  targets: Identity[];
  client: Client;
  onOpen: (draft: Pick<DraftSummary, "id" | "kind">, did: string, host?: string) => void;
}) {
  const { draft, identity } = entry;
  const [target, setTarget] = useState("");
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState("");
  const time = Date.parse(draft.scheduledAt ?? draft.updatedAt);

  async function copy() {
    if (copying || !target) return;
    const request = requestId || crypto.randomUUID();
    setRequestId(request);
    setCopying(true);
    setError("");
    try {
      const source = await client.get(draft.id);
      const created = await client.copy(draft.id, source.version, target, request);
      onOpen(created, target, targets.find(site => site.did === target)?.host);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCopying(false);
    }
  }

  return (
    <li style={{ marginBottom: "1rem", paddingBottom: ".75rem", borderBottom: "1px solid #485469" }}>
      <div style={row}>
        <strong>{draft.title || (draft.kind === "longform" ? "Untitled article" : "Untitled post")}</strong>
        <span>{identity.handle}</span>
        <span>{states[draft.state]}</span>
        {Number.isFinite(time) && <time dateTime={new Date(time).toISOString()}>{date.format(time)}</time>}
        <button onClick={() => onOpen(draft, identity.did)}>Open {draft.kind === "longform" ? "article" : "post"}</button>
      </div>
      {draft.state !== "publishing" && targets.length > 0 && (
        <div style={row}>
          <label>Copy to{" "}
            <select value={target} disabled={copying} onChange={event => { setTarget(event.target.value); setRequestId(""); }}>
              <option value="">Choose a site</option>
              {targets.map(site => <option key={site.did} value={site.did}>{site.handle}</option>)}
            </select>
          </label>
          <button disabled={!target || copying} onClick={() => void copy()}>{copying ? "Copying…" : "Copy draft"}</button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
