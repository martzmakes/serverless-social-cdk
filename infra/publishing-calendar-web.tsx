import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createEditorClient, type DraftSummary, type EditorIdentity } from "./editor";

type Identity = EditorIdentity & { host?: string };
type Client = ReturnType<typeof createEditorClient>;
type Entry = { draft: DraftSummary; identity: Identity };
type DraftPage = { drafts: DraftSummary[]; cursor?: string; error?: string };

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: ".75rem" };
const states = { draft: "Draft", scheduled: "Scheduled", publishing: "Publishing", published: "Published", failed: "Failed" };

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
