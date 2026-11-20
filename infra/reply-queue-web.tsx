import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ReplyItem } from "./article-reply-web";
import type { ArticleReply, InsightArticle, InsightsClient, InsightSite, ReplyNetwork, ReplyQueueThread } from "./insights";

type SiteQueue = { site: InsightSite; threads: ReplyQueueThread[]; next?: string; failed?: boolean };
type QueueReply = { key: string; site: InsightSite; article: InsightArticle; reply: ArticleReply };

const date = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
});

const css = `
.ss-reply-queue{box-sizing:border-box;min-width:0;max-width:100%;color:inherit;font:14px/1.55 system-ui,sans-serif;overflow-wrap:anywhere}
.ss-reply-queue h2{font-size:1.45rem;line-height:1.15;margin:0 0 .8rem}
.ss-reply-queue a{color:var(--ss-queue-link,#a8c8ff);text-underline-offset:.2em}
.ss-reply-queue button,.ss-reply-queue input,.ss-reply-queue select,.ss-reply-queue textarea{font:inherit;color:inherit;color-scheme:inherit;background:transparent;border:1px solid currentColor;border-radius:.55rem;padding:.45rem .72rem;min-height:2.55rem;box-sizing:border-box}
.ss-reply-queue select option{background:Canvas;color:CanvasText}
.ss-reply-queue button{cursor:pointer}
.ss-reply-queue button:disabled{cursor:default;opacity:.65}
.ss-reply-queue button[aria-pressed=true]{font-weight:650;background:color-mix(in srgb,var(--ss-queue-link,#a8c8ff) 17%,transparent);border-color:var(--ss-queue-link,#a8c8ff)}
.ss-reply-queue :focus-visible{outline:2px solid var(--ss-queue-link,#a8c8ff);outline-offset:3px}
.ss-reply-queue .ss-queue-controls{display:flex;gap:.55rem;flex-wrap:wrap;align-items:center}
.ss-reply-queue .ss-queue-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));gap:.65rem;margin:.9rem 0}
.ss-reply-queue label{display:grid;gap:.28rem;min-width:0}
.ss-reply-queue .ss-queue-note{font-size:.875rem;margin:.7rem 0;color:color-mix(in srgb,currentColor 83%,transparent)}
.ss-reply-queue .ss-queue-list{list-style:none;margin:.75rem 0;padding:0;display:grid;gap:.65rem}
.ss-reply-queue .ss-reply-card{border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:.85rem;padding:.85rem 1rem;background:color-mix(in srgb,currentColor 4%,transparent)}
.ss-reply-queue .ss-queue-article{margin:0 0 .4rem;border-bottom:1px solid color-mix(in srgb,currentColor 19%,transparent);padding-bottom:.42rem;font-size:.825rem}
.ss-reply-queue .ss-queue-article time{font-variant-numeric:tabular-nums}
.ss-reply-queue .ss-queue-older{display:grid;justify-items:start;gap:.5rem;margin-bottom:.75rem}
`;

function keyFor({ id, network }: ArticleReply) {
  return JSON.stringify([network, id]);
}

function replyRows(queues: SiteQueue[]): QueueReply[] {
  return queues.flatMap(({ site, threads }) => threads.flatMap(({ article, replies }) =>
    replies.map(reply => ({ key: JSON.stringify([site.did, article.rkey, reply.network, reply.id]), site, article, reply })),
  )).sort((a, b) => Date.parse(b.reply.publishedAt) - Date.parse(a.reply.publishedAt) || a.key.localeCompare(b.key));
}

function networkLabel(network: ReplyNetwork) {
  return network === "Fediverse" ? "Mastodon" : network;
}

async function fetchSiteQueue(client: InsightsClient, queue: SiteQueue, append: boolean): Promise<SiteQueue> {
  try {
    const page = await client.replyQueue(queue.site.did, append ? queue.next : undefined);
    return {
      site: queue.site,
      threads: append ? [...queue.threads, ...page.threads] : page.threads,
      next: append && queue.next === page.next ? undefined : page.next,
    };
  } catch {
    return { ...queue, failed: true };
  }
}

export function ArticleReplyQueue({ client, accent = "#a8c8ff" }: { client: InsightsClient; accent?: string }) {
  const [queues, setQueues] = useState<SiteQueue[]>();
  const [siteDid, setSiteDid] = useState("");
  const [network, setNetwork] = useState("");
  const [search, setSearch] = useState("");
  const [showHandled, setShowHandled] = useState(false);
  const [composing, setComposing] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [lastAction, setLastAction] = useState<{ item: QueueReply; handled: boolean }>();
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void client.sites()
      .then(({ sites }) => Promise.all(sites.map(site => fetchSiteQueue(client, { site, threads: [] }, false))))
      .then(result => { if (active) setQueues(result); })
      .catch(() => { if (active) setError("Couldn’t load publishing sites."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, attempt]);

  const selected = useMemo(() => (queues ?? []).filter(queue => !siteDid || siteDid === queue.site.did), [queues, siteDid]);
  const rows = useMemo(() => replyRows(selected), [selected]);
  const term = search.trim().toLowerCase();
  const matching = rows.filter(({ reply, article }) =>
    (!network || reply.network === network) &&
    (!term || [reply.author, reply.text, article.title].some(value => value.toLowerCase().includes(term))),
  );
  const openCount = matching.filter(({ reply }) => !reply.handled).length;
  const visible = matching.filter(({ reply }) => Boolean(reply.handled) === showHandled);
  const unreadable = selected.flatMap(queue => {
    if (queue.failed) return [queue.site.host];
    const unavailable = new Set(queue.threads.flatMap(thread => thread.unavailable));
    return [...unavailable].map(source => `${queue.site.host} (${networkLabel(source)})`);
  });
  const olderArticles = selected.filter(queue => queue.next);
  const olderReplies = selected.flatMap(queue => queue.threads.filter(thread => thread.next).map(thread => ({ queue, thread })));
  function updateStatus(item: QueueReply, handled: boolean) {
    setQueues(previous => previous?.map(queue => queue.site.did !== item.site.did ? queue : {
      ...queue,
      threads: queue.threads.map(thread => thread.article.rkey !== item.article.rkey ? thread : {
        ...thread,
        replies: thread.replies.map(reply => keyFor(reply) === keyFor(item.reply) ? { ...reply, handled } : reply),
      }),
    }));
  }

  async function undo() {
    if (!lastAction || undoing) return;
    const { item, handled } = lastAction;
    setUndoing(true);
    setError("");
    try {
      const result = await client.setReplyHandled(item.site.did, item.article.rkey, item.reply, !handled);
      updateStatus(item, result.handled);
      setLastAction(current => current === lastAction ? undefined : current);
    } catch {
      setError("Couldn’t undo that change. Try again.");
    } finally {
      setUndoing(false);
    }
  }

  async function loadOlderArticles() {
    setLoading(true);
    const pages = await Promise.all(olderArticles.map(queue => fetchSiteQueue(client, queue, true)));
    // Merge only the appended page, since an in-flight action can change a
    // reply that was already visible while this request was running.
    setQueues(previous => previous?.map(queue => {
      const page = pages.find(result => result.site.did === queue.site.did);
      if (!page) return queue;
      return { ...page, threads: [...queue.threads, ...page.threads.slice(queue.threads.length)] };
    }));
    setLoading(false);
  }

  async function loadOlderReplies(queue: SiteQueue, thread: ReplyQueueThread) {
    setLoading(true);
    setError("");
    try {
      const page = await client.replies(queue.site.did, thread.article.rkey, thread.next);
      if (page.unavailable.length) throw new Error("Reply source unavailable.");
      setQueues(previous => previous?.map(entry => entry.site.did !== queue.site.did ? entry : {
        ...entry,
        threads: entry.threads.map(current => {
          if (current.article.rkey !== thread.article.rkey) return current;
          const merged = new Map(current.replies.map(reply => [keyFor(reply), reply]));
          for (const reply of page.replies) if (!merged.has(keyFor(reply))) merged.set(keyFor(reply), reply);
          return { ...current, replies: [...merged.values()], next: page.next === thread.next ? undefined : page.next };
        }),
      }));
    } catch {
      setError("Couldn’t load older Mastodon replies. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="ss-reply-queue" aria-label="Article reply queue" style={{ "--ss-queue-link": accent } as CSSProperties}>
      <style>{css}</style>
      <h2>Article replies</h2>
      {queues && queues.length > 0 && (
        <>
          <div className="ss-queue-controls" role="group" aria-label="Reply status">
            <button type="button" aria-pressed={!showHandled} onClick={() => { setComposing(undefined); setShowHandled(false); }}>Open · {openCount}</button>
            <button type="button" aria-pressed={showHandled} onClick={() => { setComposing(undefined); setShowHandled(true); }}>Handled · {matching.length - openCount}</button>
            <button type="button" disabled={loading} onClick={() => { setComposing(undefined); setAttempt(n => n + 1); }}>Refresh</button>
          </div>
          <div className="ss-queue-filters">
            {queues.length > 1 && <label>Site<select value={siteDid} onChange={event => setSiteDid(event.target.value)}>
              <option value="">All sites</option>
              {queues.map(({ site }) => <option key={site.did} value={site.did}>{site.host}</option>)}
            </select></label>}
            <label>Network<select value={network} onChange={event => setNetwork(event.target.value)}>
              <option value="">All networks</option><option>Bluesky</option><option value="Fediverse">Mastodon</option>
            </select></label>
            <label>Search replies<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Author, article, or text" /></label>
          </div>
        </>
      )}
      {loading && <p className="ss-queue-note" role="status">Loading replies…</p>}
      {error && <p role="alert">{error}{!queues && <button type="button" onClick={() => setAttempt(n => n + 1)}>Try again</button>}</p>}
      {!!unreadable.length && <p role="status">Some replies couldn’t load from {unreadable.join(", ")}. Refresh to try again.</p>}
      {lastAction && <div className="ss-queue-controls">
        <span role="status">{lastAction.handled ? "Reply marked handled." : "Reply reopened."}</span>
        <button type="button" disabled={undoing} onClick={() => void undo()}>Undo</button>
      </div>}
      {!!visible.length && <ul className="ss-queue-list">
        {visible.map(item => (
          <ReplyItem key={item.key} reply={item.reply} site={item.site} client={client} rkey={item.article.rkey}
            composing={composing === item.key} onCompose={active => setComposing(active ? item.key : undefined)}
            onHandled={handled => { updateStatus(item, handled); setLastAction({ item, handled }); }}
            context={<p className="ss-queue-article"><a href={item.article.url}>{item.article.title}</a> · {item.site.host} ·{" "}
              <time dateTime={item.reply.publishedAt}>{date.format(new Date(item.reply.publishedAt))}</time></p>}
          />
        ))}
      </ul>}
      {!loading && queues && !queues.length && <p>No publishing sites are available for this account.</p>}
      {!loading && !!queues?.length && !visible.length && <p role="status">
        {term ? "No replies match this search." : `No ${showHandled ? "handled" : "open"} replies${olderArticles.length || olderReplies.length ? " in the articles loaded" : ""}.`}
      </p>}
      {!!olderReplies.length && <details>
        <summary>Older Mastodon replies</summary>
        <div className="ss-queue-older">
          {olderReplies.map(({ queue, thread }) => <button key={`${queue.site.did}:${thread.article.rkey}`} type="button" disabled={loading}
            onClick={() => void loadOlderReplies(queue, thread)}>{thread.article.title} · {queue.site.host}</button>)}
        </div>
      </details>}
      {!!olderArticles.length && <>
        <p className="ss-queue-note">Showing replies from the articles loaded so far, newest replies first.</p>
        <button type="button" disabled={loading} onClick={() => void loadOlderArticles()}>Load older articles</button>
      </>}
    </section>
  );
}
