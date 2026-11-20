import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  DirectMessagesError, MESSAGE_MAX_GRAPHEMES, messageLength, messageTooLong,
  type ChatProfile, type Conversation, type ConversationPage, type DirectMessage,
  type DirectMessagesClient, type MessagePage,
} from "./direct-messages";

const blueskyMessages = "https://bsky.app/messages";
const messageTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const previewDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const css = `
.ss-dm{box-sizing:border-box;min-width:0;color:inherit;font:14px/1.55 system-ui,sans-serif;overflow-wrap:anywhere}
.ss-dm *{box-sizing:border-box}
.ss-dm h2,.ss-dm h3,.ss-dm p{margin:0}
.ss-dm h2{font-size:1.9rem;line-height:1.15;letter-spacing:-.045em}
.ss-dm h3{font-size:1.1rem;line-height:1.25}
.ss-dm a{color:var(--ss-dm-accent);text-underline-offset:.2em}
.ss-dm button,.ss-dm input,.ss-dm textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--ss-dm-border);border-radius:.6rem;padding:.5rem .7rem;min-height:2.65rem;min-width:0}
.ss-dm button{cursor:pointer;font-weight:600}
.ss-dm button:not(:disabled):hover{background:var(--ss-dm-accent-surface)}
.ss-dm button:disabled{opacity:.62;cursor:default}
.ss-dm :focus-visible{outline:2px solid var(--ss-dm-accent);outline-offset:3px}
.ss-dm{--ss-dm-border:color-mix(in srgb,currentColor 23%,transparent);--ss-dm-muted:color-mix(in srgb,currentColor 78%,transparent);--ss-dm-surface:color-mix(in srgb,currentColor 5%,transparent);--ss-dm-accent-surface:color-mix(in srgb,var(--ss-dm-accent) 14%,transparent)}
.ss-dm .ss-dm-top{display:flex;align-items:flex-end;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem}
.ss-dm .ss-dm-kicker{font-size:.75rem;font-weight:700;letter-spacing:.075em;text-transform:uppercase;color:var(--ss-dm-accent);margin-bottom:.15rem}
.ss-dm .ss-dm-meta{font-size:.83rem;color:var(--ss-dm-muted)}
.ss-dm .ss-dm-layout{border:1px solid var(--ss-dm-border);border-radius:1rem;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.9fr);min-height:24rem}
.ss-dm .ss-dm-sidebar,.ss-dm .ss-dm-thread{min-width:0}
.ss-dm .ss-dm-sidebar{border-inline-end:1px solid var(--ss-dm-border);padding:.85rem}
.ss-dm .ss-dm-toolbar{display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap;margin-bottom:.65rem}
.ss-dm .ss-dm-list,.ss-dm .ss-dm-history ol{list-style:none;padding:0;margin:0;display:grid;gap:.42rem}
.ss-dm .ss-dm-list button{width:100%;text-align:start;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.24rem .45rem;border-color:transparent;padding:.6rem .68rem}
.ss-dm .ss-dm-list button[aria-pressed=true]{border-color:var(--ss-dm-accent);background:var(--ss-dm-accent-surface)}
.ss-dm .ss-dm-list time{font-weight:400}
.ss-dm .ss-dm-preview{grid-column:1 / -1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:400;color:var(--ss-dm-muted)}
.ss-dm .ss-dm-empty{padding:1.15rem;margin:auto 0;color:var(--ss-dm-muted)}
.ss-dm .ss-dm-thread{display:grid;align-content:start}
.ss-dm .ss-dm-thread-top{padding:.9rem 1rem;border-bottom:1px solid var(--ss-dm-border)}
.ss-dm .ss-dm-thread-top [tabindex]{width:fit-content}
.ss-dm .ss-dm-history{max-height:min(52vh,32rem);min-height:10rem;overflow:auto;padding:.75rem 1rem}
.ss-dm .ss-dm-history li{display:grid;justify-items:start;gap:.18rem}
.ss-dm .ss-dm-history li[data-sent=true]{justify-items:end}
.ss-dm .ss-dm-bubble{border:1px solid var(--ss-dm-border);border-radius:.8rem;background:var(--ss-dm-surface);padding:.48rem .65rem;white-space:pre-wrap;max-width:min(90%,40ch)}
.ss-dm [data-sent=true] .ss-dm-bubble{background:var(--ss-dm-accent-surface)}
.ss-dm .ss-dm-older{display:flex;justify-content:center;padding-bottom:.65rem}
.ss-dm .ss-dm-compose,.ss-dm .ss-dm-panel{padding:.85rem 1rem;display:grid;gap:.55rem}
.ss-dm .ss-dm-panel .ss-dm-toolbar{justify-content:flex-start;gap:.85rem}
.ss-dm .ss-dm-compose{border-top:1px solid var(--ss-dm-border)}
.ss-dm .ss-dm-new{padding:.65rem 0 .9rem;display:grid;gap:.45rem}
.ss-dm .ss-dm-new input,.ss-dm .ss-dm-compose textarea{width:100%;background:var(--ss-dm-surface);resize:vertical}
.ss-dm .ss-dm-actions{display:flex;align-items:center;justify-content:flex-end;gap:.55rem;flex-wrap:wrap}
.ss-dm .ss-dm-primary{border-color:var(--ss-dm-accent);background:var(--ss-dm-accent-surface)}
.ss-dm .ss-dm-error{border-inline-start:3px solid var(--ss-dm-accent);padding:.35rem .6rem;background:var(--ss-dm-surface)}
.ss-dm .ss-dm-back{display:none}
@media(max-width:680px){
 .ss-dm .ss-dm-layout{grid-template-columns:minmax(0,1fr);min-height:0}
 .ss-dm .ss-dm-sidebar{border-inline-end:0}
 .ss-dm .ss-dm-layout[data-open=true] .ss-dm-sidebar,.ss-dm .ss-dm-layout[data-open=false] .ss-dm-thread,.ss-dm .ss-dm-empty{display:none}
 .ss-dm .ss-dm-back{display:inline-block;margin:0 0 .55rem}
 .ss-dm .ss-dm-history{max-height:min(50dvh,25rem)}
}
`;

function displayName(person: ChatProfile) {
  return person.displayName || `@${person.handle}`;
}

function conversationLabel(conversation: Conversation, actor: ChatProfile) {
  const others = conversation.participants.filter(person => person.did !== actor.did);
  return conversation.name || others.map(displayName).join(", ") || "Bluesky conversation";
}

function content(message?: DirectMessage) {
  if (!message) return "No messages yet";
  if (message.kind === "deleted") return "Message deleted";
  if (message.kind === "activity") return "Conversation activity";
  return message.text || "Shared a post or attachment";
}

function mergeRows<T extends { id: string }>(first: T[], next: T[]) {
  const unique = new Map(first.map(item => [item.id, item]));
  for (const item of next) unique.set(item.id, item);
  return [...unique.values()];
}

function mergeProfiles(first: ChatProfile[], next: ChatProfile[]) {
  const unique = new Map(first.map(person => [person.did, person]));
  for (const person of next) unique.set(person.did, person);
  return [...unique.values()];
}

function problemText(error: unknown) {
  return error instanceof DirectMessagesError ? error.message : "Could not load your messages. Try again.";
}

type Composer = { text: string; status?: "busy" | "sent" | "uncertain"; error?: string };

function Thread({
  client, actor, conversation, composer, updateComposer, onBack, onSent,
}: {
  client: DirectMessagesClient;
  actor: ChatProfile;
  conversation: Conversation;
  composer: Composer;
  updateComposer: (update: (previous: Composer) => Composer) => void;
  onBack: () => void;
  onSent: (message: DirectMessage) => void;
}) {
  const [page, setPage] = useState<MessagePage>();
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [readError, setReadError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const scrollAfterRender = useRef<number | undefined>(undefined);
  const fieldId = useId();
  const countId = useId();
  const { id } = conversation;
  const { text, status: sendState, error: sendError } = composer;
  const tooLong = messageTooLong(text);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const request = new AbortController();
    setReadError("");
    setLoading(true);
    void client.messages(id, undefined, request.signal)
      .then(result => {
        if (request.signal.aborted) return;
        scrollAfterRender.current = 0;
        setPage(result);
        if (refresh) {
          updateComposer(previous => previous.status === "uncertain" ? { text: previous.text } : previous);
        }
      })
      .catch(error => { if (!request.signal.aborted) setReadError(problemText(error)); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [client, id, refresh, updateComposer]);

  useEffect(() => {
    if (history.current && scrollAfterRender.current !== undefined) {
      history.current.scrollTop = history.current.scrollHeight - scrollAfterRender.current;
      scrollAfterRender.current = undefined;
    }
  }, [page]);

  async function older() {
    if (!page?.next || loadingOlder || loading) return;
    setLoadingOlder(true);
    setReadError("");
    try {
      const result = await client.messages(id, page.next);
      if (history.current) scrollAfterRender.current = history.current.scrollHeight - history.current.scrollTop;
      setPage(previous => previous && ({
        messages: mergeRows(previous.messages, result.messages),
        profiles: mergeProfiles(previous.profiles, result.profiles),
        next: result.next === page.next ? undefined : result.next,
      }));
    } catch (error) {
      setReadError(problemText(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!page || sendState === "busy" || sendState === "uncertain" || loading || !text.trim() || tooLong) return;
    updateComposer(() => ({ text, status: "busy" }));
    try {
      const result = await client.send(id, text);
      updateComposer(() => ({ text: "", status: "sent" }));
      scrollAfterRender.current = 0;
      setPage(previous => previous && ({ ...previous, messages: mergeRows(previous.messages, [result.message]) }));
      onSent(result.message);
    } catch (error) {
      updateComposer(() => ({
        text, error: problemText(error),
        status: error instanceof DirectMessagesError && error.code === "send_uncertain" ? "uncertain" : undefined,
      }));
    }
  }

  const people = new Map([...conversation.participants, ...(page?.profiles ?? [])].map(person => [person.did, person]));
  const others = conversation.participants.filter(person => person.did !== actor.did);
  const peer = others.length === 1 ? others[0] : undefined;
  const chronological = [...(page?.messages ?? [])].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const conversationUrl = `${blueskyMessages}/${encodeURIComponent(id)}`;
  return <section className="ss-dm-thread" aria-label="Open conversation">
    <div className="ss-dm-thread-top">
      <button type="button" className="ss-dm-back" onClick={onBack}>Back to conversations</button>
      <div className="ss-dm-toolbar">
        <h3 ref={heading} tabIndex={-1}>{conversationLabel(conversation, actor)}</h3>
        <button type="button" onClick={() => setRefresh(value => value + 1)}
          disabled={loading || loadingOlder || sendState === "busy"}>{loading ? "Refreshing…" : "Refresh conversation"}</button>
      </div>
      <p className="ss-dm-meta">
        {peer?.displayName && `@${peer.handle} · `}
        <a href={conversationUrl} rel="noreferrer">Open in Bluesky</a>
      </p>
    </div>
    <div className="ss-dm-history" ref={history} aria-busy={loading || loadingOlder}>
      {page?.next && <div className="ss-dm-older">
        <button type="button" onClick={() => void older()} disabled={loading || loadingOlder}>{loadingOlder ? "Loading…" : "Load earlier messages"}</button>
      </div>}
      {readError && <p className="ss-dm-error" role="alert">{readError}</p>}
      {loading && !page && <p role="status">Loading messages…</p>}
      {page && !chronological.length && !page.next && <p>No messages yet.</p>}
      <ol aria-label="Messages in this conversation">
        {chronological.map(message => {
          const sender = message.kind === "activity" ? undefined : people.get(message.senderDid);
          const sent = message.kind !== "activity" && message.senderDid === actor.did;
          return <li key={message.id} data-sent={sent}>
            <span className="ss-dm-meta">
              {sent ? "You" : sender ? displayName(sender) : ""}
              {(sent || sender) && " · "}<time dateTime={message.sentAt}>{messageTime.format(new Date(message.sentAt))}</time>
            </span>
            <p className="ss-dm-bubble">{content(message)}</p>
          </li>;
        })}
      </ol>
    </div>
    {conversation.status === "request" || conversation.locked
      ? <div className="ss-dm-panel">
        <p>{conversation.locked ? "This conversation is locked on Bluesky." : "Open this message request in Bluesky to respond."}</p>
      </div>
      : <form className="ss-dm-compose" onSubmit={event => void send(event)}>
        <label htmlFor={fieldId}>Message</label>
        <textarea id={fieldId} rows={3} value={text} placeholder="Write a message…" autoComplete="off" maxLength={10_000}
          onChange={event => {
            const text = event.target.value;
            updateComposer(previous => ({ ...previous, text, status: previous.status === "sent" ? undefined : previous.status }));
          }}
          disabled={sendState === "busy"} aria-describedby={countId} aria-invalid={tooLong || undefined} />
        {sendError && <p role="alert" className="ss-dm-error">{sendError}</p>}
        {tooLong && <p className="ss-dm-meta">This message exceeds Bluesky’s length limit.</p>}
        <div className="ss-dm-actions">
          {sendState === "sent" && <span role="status">Message sent.</span>}
          <span id={countId} className="ss-dm-meta">{messageLength(text).toLocaleString()} / {MESSAGE_MAX_GRAPHEMES.toLocaleString()}</span>
          <button type="submit" className="ss-dm-primary"
            disabled={!page || loading || sendState === "busy" || sendState === "uncertain" || !text.trim() || tooLong}>
            {sendState === "busy" ? "Sending…" : "Send message"}
          </button>
        </div>
      </form>}
  </section>;
}

export function DirectMessages({ client, accent = "#346ef3" }: { client: DirectMessagesClient; accent?: string }) {
  const [list, setList] = useState<{ client: DirectMessagesClient; page: ConversationPage }>();
  const [selectedId, setSelectedId] = useState<string>();
  const [drafts, setDrafts] = useState<Map<string, Composer>>(new Map());
  const [refresh, setRefresh] = useState(0);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const listScope = useRef<HTMLHeadingElement>(null);
  const requestScope = useRef<{ client: DirectMessagesClient; request: AbortController }>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const handleId = useId();
  const page = list?.client === client ? list.page : undefined;
  const selected = page?.conversations.find(row => row.id === selectedId);

  useEffect(() => {
    const request = new AbortController();
    requestScope.current = { client, request };
    setSelectedId(undefined);
    setDrafts(new Map());
    setNewOpen(false);
    setRecipient("");
    setOpenError("");
    setOpening(false);
    return () => request.abort();
  }, [client]);

  useEffect(() => {
    const request = new AbortController();
    setListBusy(true);
    setListError("");
    void client.list(undefined, request.signal)
      .then(result => {
        if (!request.signal.aborted) setList({ client, page: result });
      })
      .catch(error => { if (!request.signal.aborted) setListError(problemText(error)); })
      .finally(() => { if (!request.signal.aborted) setListBusy(false); });
    return () => request.abort();
  }, [client, refresh]);

  function updatePage(fn: (current: ConversationPage) => ConversationPage) {
    setList(previous => previous?.client === client ? { client, page: fn(previous.page) } : previous);
  }

  const updateSelectedComposer = useCallback((update: (previous: Composer) => Composer) => {
    const scope = requestScope.current;
    if (!selectedId || scope?.client !== client || scope.request.signal.aborted) return;
    setDrafts(previous => {
      const current = previous.get(selectedId) ?? { text: "" };
      const updated = update(current);
      if (updated === current) return previous;
      const next = new Map(previous);
      next.set(selectedId, updated);
      return next;
    });
  }, [client, selectedId]);

  async function more() {
    if (!page?.next || listBusy) return;
    const signal = requestScope.current?.request.signal;
    setListBusy(true);
    setListError("");
    try {
      const result = await client.list(page.next, signal);
      if (signal?.aborted) return;
      updatePage(previous => ({
        ...result,
        conversations: mergeRows(previous.conversations, result.conversations),
        next: result.next === page.next ? undefined : result.next,
      }));
    } catch (error) {
      if (!signal?.aborted) setListError(problemText(error));
    } finally {
      if (!signal?.aborted) setListBusy(false);
    }
  }

  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recipient.trim() || opening || listBusy) return;
    const signal = requestScope.current?.request.signal;
    setOpening(true);
    setOpenError("");
    try {
      const { conversation } = await client.open(recipient, signal);
      if (signal?.aborted) return;
      updatePage(previous => ({
        ...previous,
        conversations: [conversation, ...previous.conversations.filter(row => row.id !== conversation.id)],
      }));
      setSelectedId(conversation.id);
      setRecipient("");
      setNewOpen(false);
    } catch (error) {
      if (!signal?.aborted) setOpenError(problemText(error));
    } finally {
      if (!signal?.aborted) setOpening(false);
    }
  }

  return <div className="ss-dm" style={{ "--ss-dm-accent": accent } as CSSProperties}>
    <style>{css}</style>
    <header className="ss-dm-top">
      <div>
        <p className="ss-dm-kicker">Bluesky Chat</p>
        <h2>Messages</h2>
        {page && <p className="ss-dm-meta">Signed in as @{page.actor.handle}</p>}
      </div>
      {page && <button ref={newButton} className="ss-dm-primary" type="button" aria-expanded={newOpen}
        disabled={opening}
        onClick={() => { setNewOpen(visible => !visible); setSelectedId(undefined); }}>New message</button>}
    </header>
    {!page && <div className="ss-dm-panel">
      {listBusy && <p role="status">Loading conversations…</p>}
      {listError && <>
        <p role="alert" className="ss-dm-error">{listError}</p>
        <div className="ss-dm-toolbar">
          <button type="button" onClick={() => setRefresh(value => value + 1)}>Try again</button>
          <a href={blueskyMessages} rel="noreferrer">Open Bluesky Chat</a>
        </div>
      </>}
    </div>}
    {page && <div className="ss-dm-layout" data-open={Boolean(selected)}>
      <section className="ss-dm-sidebar" aria-label="Conversations">
        <div className="ss-dm-toolbar">
          <h3 tabIndex={-1} ref={listScope}>Conversations</h3>
          <button type="button" onClick={() => setRefresh(value => value + 1)}
            disabled={listBusy || opening}>Refresh conversations</button>
        </div>
        {newOpen && <form className="ss-dm-new" onSubmit={event => void open(event)}>
          <label htmlFor={handleId}>Bluesky handle</label>
          <input id={handleId} value={recipient} onChange={event => setRecipient(event.target.value)}
            placeholder="@someone.bsky.social" autoComplete="off" autoCapitalize="none" spellCheck={false}
            maxLength={254} autoFocus disabled={opening} />
          {openError && <p role="alert" className="ss-dm-error">{openError}</p>}
          <div className="ss-dm-actions">
            <button type="button" disabled={opening} onClick={() => { setNewOpen(false); newButton.current?.focus(); }}>Cancel</button>
            <button type="submit" className="ss-dm-primary" disabled={!recipient.trim() || opening || listBusy}>
              {opening ? "Opening…" : "Open conversation"}
            </button>
          </div>
        </form>}
        {listError && <p role="alert" className="ss-dm-error">{listError}</p>}
        {listBusy && <p className="ss-dm-meta" role="status">Updating conversations…</p>}
        {!page.conversations.length && !newOpen && <p className="ss-dm-meta">No conversations yet. Start one with a Bluesky handle.</p>}
        <ul className="ss-dm-list">
          {page.conversations.map(conversation => <li key={conversation.id}>
            <button type="button" aria-pressed={conversation.id === selectedId}
              disabled={opening}
              onClick={() => { setNewOpen(false); setSelectedId(conversation.id); }}>
              <span>{conversationLabel(conversation, page.actor)}</span>
              {conversation.lastMessage && <time className="ss-dm-meta" dateTime={conversation.lastMessage.sentAt}>
                {previewDate.format(new Date(conversation.lastMessage.sentAt))}
              </time>}
              <span className="ss-dm-preview">{conversation.status === "request" ? "Message request · " : ""}{content(conversation.lastMessage)}</span>
            </button>
          </li>)}
        </ul>
        {page.next && <button type="button" onClick={() => void more()} disabled={listBusy}>Load more conversations</button>}
      </section>
      {selected ? <Thread key={selected.id} client={client} actor={page.actor} conversation={selected}
        composer={drafts.get(selected.id) ?? { text: "" }}
        updateComposer={updateSelectedComposer}
        onBack={() => { setSelectedId(undefined); requestAnimationFrame(() => listScope.current?.focus()); }}
        onSent={message => updatePage(previous => {
          const conversation = previous.conversations.find(row => row.id === selected.id);
          if (!conversation) return previous;
          return { ...previous, conversations: [{ ...conversation, lastMessage: message }, ...previous.conversations.filter(row => row.id !== selected.id)] };
        })} /> : <p className="ss-dm-empty">Choose a conversation or start a new message.</p>}
    </div>}
  </div>;
}
