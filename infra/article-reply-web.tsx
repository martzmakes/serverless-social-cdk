import { useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { ArticleReply, InsightSite, InsightsClient, ReplySubmission } from "./insights";

const layout: CSSProperties = { display: "flex", flexWrap: "wrap", gap: ".65rem", alignItems: "center" };
const field: CSSProperties = { display: "grid", gap: ".35rem", minWidth: 0 };

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not update this reply.";
}

export function ReplyItem({ reply, site, client, rkey, composing, onCompose, onHandled, context }: {
  reply: ArticleReply; site: InsightSite; client: InsightsClient; rkey: string; composing: boolean;
  onCompose: (active: boolean) => void; onHandled: (handled: boolean) => void;
  context?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ReplySubmission>();
  const submission = useRef<{ text: string; id: string }>(undefined);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = text.trim();
    if (!normalized || pending) return;
    setPending(true);
    setError("");
    try {
      const intent = submission.current?.text === normalized ? submission.current : { text: normalized, id: crypto.randomUUID() };
      submission.current = intent;
      const result = await client.sendReply(site.did, rkey, reply, intent.text, intent.id);
      setReceipt(result);
      setText("");
      submission.current = undefined;
      onCompose(false);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function changeStatus() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await client.setReplyHandled(site.did, rkey, reply, !reply.handled);
      onHandled(result.handled);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className={context ? "ss-reply-card" : undefined} style={context ? undefined : { marginBlock: "1rem" }}>
      {context}
      <strong>{reply.author}</strong> · <span>{reply.network}</span>
      <p style={{ whiteSpace: "pre-wrap", marginBlock: ".35rem" }}>{reply.text}</p>
      <div style={layout}>
        <a href={reply.url}>Open reply on {reply.network}</a>
        {!composing && <button type="button" disabled={pending} onClick={() => { setError(""); onCompose(true); }}>Reply</button>}
        <button type="button" disabled={pending} onClick={() => void changeStatus()}>{reply.handled ? "Reopen" : "Mark handled"}</button>
      </div>
      {composing && (
        <form onSubmit={send} style={{ marginBlock: ".75rem" }}>
          <label style={field}>Reply as @{site.handle} on {reply.network}
            <textarea rows={3} style={{ minWidth: 0, maxWidth: "100%", padding: ".45rem", font: "inherit", resize: "vertical" }} value={text} maxLength={3000}
              onChange={event => setText(event.target.value)} disabled={pending} />
          </label>
          <small>Up to 300 characters.</small>
          <div style={{ ...layout, marginBlock: ".5rem" }}>
            <button type="submit" disabled={pending || !text.trim()}>{pending ? "Sending…" : "Send public reply"}</button>
            <button type="button" disabled={pending} onClick={() => { setError(""); onCompose(false); }}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {receipt && <p role="status">
        {receipt.status === "queued" ? "Queued for delivery." : "Reply sent."}{' '}
        <a href={receipt.url}>Open your reply</a>
      </p>}
    </li>
  );
}
