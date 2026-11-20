import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  FEDIVERSE_MESSAGE_LIMIT,
  type FediverseMessage, type FediverseMessageInput, type FediverseMessagesClient,
} from "./fediverse-messages";

const css = `
.ss-fedi{box-sizing:border-box;min-width:0;font:14px/1.55 system-ui,sans-serif;overflow-wrap:anywhere;
  --ss-fedi-border:color-mix(in srgb,currentColor 23%,transparent);
  --ss-fedi-surface:color-mix(in srgb,currentColor 5%,transparent);
  --ss-fedi-muted:color-mix(in srgb,currentColor 78%,transparent)}
.ss-fedi *{box-sizing:border-box}
.ss-fedi p,.ss-fedi h2,.ss-fedi h3{margin:0}
.ss-fedi h2{font-size:1.9rem;letter-spacing:-.04em;line-height:1.15}
.ss-fedi h3{font-size:1.07rem}
.ss-fedi button,.ss-fedi input,.ss-fedi textarea{font:inherit;color:inherit;border:1px solid var(--ss-fedi-border);border-radius:.6rem;background:transparent;min-height:44px;padding:.5rem .75rem}
.ss-fedi button{cursor:pointer;font-weight:600}
.ss-fedi button:disabled{opacity:.65;cursor:default}
.ss-fedi :focus-visible{outline:2px solid var(--ss-fedi-accent);outline-offset:3px}
.ss-fedi input,.ss-fedi textarea{width:100%;background:var(--ss-fedi-surface);min-width:0}
.ss-fedi textarea{resize:vertical;min-height:6rem}
.ss-fedi label{display:grid;gap:.25rem}
.ss-fedi .ss-fedi-top,.ss-fedi .ss-fedi-actions,.ss-fedi .ss-fedi-between{display:flex;justify-content:space-between;align-items:center;gap:.65rem;flex-wrap:wrap}
.ss-fedi .ss-fedi-actions{justify-content:flex-end;gap:.45rem}
.ss-fedi .ss-fedi-primary{border-color:var(--ss-fedi-accent);background:color-mix(in srgb,var(--ss-fedi-accent) 14%,transparent)}
.ss-fedi .ss-fedi-meta{font-size:.87rem;color:var(--ss-fedi-muted)}
.ss-fedi .ss-fedi-help{margin:.55rem 0 1.1rem;color:var(--ss-fedi-muted)}
.ss-fedi .ss-fedi-composer,.ss-fedi .ss-fedi-list li,.ss-fedi .ss-fedi-empty{border:1px solid var(--ss-fedi-border);border-radius:.8rem;padding:1rem;background:var(--ss-fedi-surface)}
.ss-fedi .ss-fedi-composer{margin-bottom:.9rem;display:grid;gap:.75rem}
.ss-fedi .ss-fedi-list{display:grid;gap:.6rem;padding:0;margin:0 0 .75rem;list-style:none}
.ss-fedi .ss-fedi-list li{display:grid;gap:.5rem}
.ss-fedi .ss-fedi-split{display:grid;grid-template-columns:minmax(12rem,.9fr) minmax(0,1.9fr);gap:.8rem}
.ss-fedi .ss-fedi-peers,.ss-fedi .ss-fedi-thread{display:grid;align-content:start;gap:.45rem;min-width:0}
.ss-fedi .ss-fedi-peers button{width:100%;text-align:left}
.ss-fedi .ss-fedi-peers button[aria-pressed=true]{border-color:var(--ss-fedi-accent);background:var(--ss-fedi-surface)}
.ss-fedi .ss-fedi-history{max-height:min(52vh,33rem);overflow:auto;padding:.25rem}
.ss-fedi .ss-fedi-back{display:none}
@media(max-width:710px){
  .ss-fedi .ss-fedi-split{grid-template-columns:minmax(0,1fr)}
  .ss-fedi .ss-fedi-split[data-open=false] .ss-fedi-thread,.ss-fedi .ss-fedi-split[data-open=true] .ss-fedi-peers{display:none}
  .ss-fedi .ss-fedi-back{display:inline-block;justify-self:start}
}
.ss-fedi .ss-fedi-list time{font-size:.8rem;color:var(--ss-fedi-muted)}
.ss-fedi .ss-fedi-text{white-space:pre-wrap}
.ss-fedi .ss-fedi-announcement{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.ss-fedi [role=alert]{margin:.55rem 0;padding:.5rem .75rem;border-inline-start:3px solid var(--ss-fedi-accent);background:var(--ss-fedi-surface)}
`;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
const count = (text: string) => segmenter ? Array.from(segmenter.segment(text)).length : Array.from(text).length;

function sendRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const stateLabel = {
  received: "",
  sending: "Sending…",
  accepted: "Accepted by recipient server",
  rejected: "Recipient server declined",
  uncertain: "Delivery unconfirmed",
};

export function FediverseMessages({ client, accent = "#82aaff", split = false }: { client: FediverseMessagesClient; accent?: string; split?: boolean }) {
  const headingId = useId();
  const lengthId = useId();
  const [messages, setMessages] = useState<FediverseMessage[]>([]);
  const [peer, setPeer] = useState<string>();
  const [actor, setActor] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [compose, setCompose] = useState(false);
  const [reply, setReply] = useState<FediverseMessage>();
  const [recipient, setRecipient] = useState("");
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const composeButton = useRef<HTMLButtonElement>(null);
  const recipientInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const loadController = useRef<AbortController | undefined>(undefined);
  const sendController = useRef<AbortController | undefined>(undefined);
  const lastRequest = useRef<{ signature: string; id: string } | undefined>(undefined);

  const refresh = useCallback(async (after?: string) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const page = await client.list(after, controller.signal);
      if (controller.signal.aborted) return;
      setActor(page.actor.acct);
      setCursor(page.cursor);
      setMessages(previous => after
        ? [...previous, ...page.messages.filter(item => !previous.some(message => message.id === item.id))]
        : page.messages);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not open Fediverse messages.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    setMessages([]);
    setPeer(undefined);
    setActor(undefined);
    setCursor(undefined);
    setPending(false);
    setCompose(false);
    setReply(undefined);
    setRecipient("");
    setText("");
    setAnnouncement("");
    lastRequest.current = undefined;
    void refresh();
    return () => {
      loadController.current?.abort();
      sendController.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (compose) (reply ? messageInput.current : recipientInput.current)?.focus();
  }, [compose, reply]);

  function openComposer(parent?: FediverseMessage) {
    setReply(parent);
    setCompose(true);
    setError(undefined);
  }

  function closeComposer() {
    setCompose(false);
    setReply(undefined);
    setRecipient("");
    setText("");
    lastRequest.current = undefined;
    requestAnimationFrame(() => composeButton.current?.focus());
  }

  async function submit(command: FediverseMessageInput | { retry: string }) {
    const controller = new AbortController();
    sendController.current = controller;
    setPending(true);
    setError(undefined);
    setAnnouncement("");
    try {
      const { message } = await client.send(command, controller.signal);
      if (controller.signal.aborted) return;
      setMessages(previous => [message, ...previous.filter(item => item.id !== message.id)]
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt)));
      const status = stateLabel[message.status];
      setAnnouncement(status);
      if (!("retry" in command)) closeComposer();
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Send status could not be confirmed.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || loading || !canSend) return;
    const target = reply ? { replyTo: reply.id } : { recipient: recipient.trim() };
    const signature = JSON.stringify([target, text]);
    if (lastRequest.current?.signature !== signature) {
      lastRequest.current = { signature, id: sendRequestId() };
    }
    void submit({ ...target, text, requestId: lastRequest.current.id });
  }

  const length = count(text);
  const canSend = !!text.trim() && length <= FEDIVERSE_MESSAGE_LIMIT && (!!reply || !!recipient.trim());
  const peers = [...new Set(messages.map(message => message.peer))];
  const activePeer = peer && peers.includes(peer) ? peer : peers[0];
  const thread = split ? messages.filter(message => message.peer === activePeer).reverse() : messages;
  const history = <ol className="ss-fedi-list">
    {thread.map(message => {
      const date = new Date(message.sentAt);
      return <li key={message.id}>
        <div className="ss-fedi-between">
          <h3>{split ? message.direction === "received" ? message.peer : "You" : `${message.direction === "received" ? "From" : "To"} ${message.peer}`}</h3>
          {Number.isFinite(date.getTime()) && <time dateTime={message.sentAt}>{dateFormat.format(date)}</time>}
        </div>
        <p className="ss-fedi-text">{message.text}</p>
        <div className="ss-fedi-between">
          {stateLabel[message.status] && <p className="ss-fedi-meta">{stateLabel[message.status]}</p>}
          {message.direction === "received" && <button type="button" disabled={pending || compose}
            aria-label={`Reply to ${message.peer}`} onClick={() => openComposer(message)}>Reply</button>}
          {message.status === "uncertain" && <button type="button" disabled={pending || loading}
            onClick={() => void submit({ retry: message.id })}>Retry send</button>}
        </div>
      </li>;
    })}
  </ol>;
  return (
    <section className="ss-fedi" style={{ "--ss-fedi-accent": accent } as CSSProperties} aria-labelledby={headingId}>
      <style>{css}</style>
      <header className="ss-fedi-top">
        <div>
          <h2 id={headingId}>Fediverse messages</h2>
          {actor && <p className="ss-fedi-meta">Signed in as {actor}</p>}
        </div>
        <div className="ss-fedi-actions">
          <button type="button" disabled={loading || pending} onClick={() => void refresh()}>Refresh</button>
          <button type="button" ref={composeButton} className="ss-fedi-primary" disabled={!actor || pending || compose}
            onClick={() => openComposer()}>New message</button>
        </div>
      </header>
      <p className="ss-fedi-help">Send a private mention to one account. The recipient’s server can read it.</p>

      {compose && <form className="ss-fedi-composer" onSubmit={send}>
        {reply ? <h3>Reply to {reply.peer}</h3> : <label>Fediverse address
          <input ref={recipientInput} value={recipient} onChange={event => setRecipient(event.currentTarget.value)}
            disabled={pending} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
            maxLength={320} placeholder="@name@mastodon.social" required />
        </label>}
        <label>Message
          <textarea ref={messageInput} value={text} onChange={event => setText(event.currentTarget.value)}
            disabled={pending} maxLength={8_000} aria-describedby={lengthId} required />
        </label>
        <p className="ss-fedi-meta" id={lengthId}>{length} / {FEDIVERSE_MESSAGE_LIMIT}</p>
        <div className="ss-fedi-actions">
          <button type="button" disabled={pending} onClick={closeComposer}>Cancel</button>
          <button type="submit" className="ss-fedi-primary" disabled={!canSend || pending || loading}>Send private mention</button>
        </div>
      </form>}

      {error && <p role="alert">{error}</p>}
      <div className="ss-fedi-announcement" aria-live="polite">{announcement}</div>
      {loading && <p className="ss-fedi-meta" role="status">Loading messages…</p>}
      {!loading && actor && !messages.length && <p className="ss-fedi-empty">No Fediverse messages yet.</p>}
      {!!messages.length && (split ? <div className="ss-fedi-split" data-open={!!peer && peers.includes(peer)}>
        <section className="ss-fedi-peers" aria-label="Fediverse conversations"><h3>Conversations</h3>
          {peers.map(item => <button type="button" key={item} disabled={compose || pending}
            aria-pressed={activePeer === item} onClick={() => setPeer(item)}>{item}</button>)}
        </section>
        <section className="ss-fedi-thread" aria-label="Open Fediverse conversation">
          <button type="button" className="ss-fedi-back" disabled={compose || pending} onClick={() => setPeer(undefined)}>All conversations</button>
          <h3>{activePeer}</h3><div className="ss-fedi-history" tabIndex={0}>{history}</div>
        </section>
      </div> : history)}
      {cursor && <button type="button" disabled={loading || pending} onClick={() => void refresh(cursor)}>Load older messages</button>}
    </section>
  );
}
