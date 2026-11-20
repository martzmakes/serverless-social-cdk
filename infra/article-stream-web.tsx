import { useCallback, useEffect, useRef, useState } from "react";
import { ReplyItem } from "./article-reply-web";
import type { ArticleReply, InsightArticle, InsightSite, InsightsClient } from "./insights";

export type StreamReply = { article: InsightArticle; reply: ArticleReply };
type StreamPage = { site: InsightSite; entries: StreamReply[]; next?: string; partial: boolean };
const replyKey = ({ article, reply }: StreamReply) => `${article.rkey}:${reply.network}:${reply.id}`;

export function useArticleStream(client: InsightsClient, host: string, enabled: boolean) {
  const [data, setData] = useState<StreamPage>();
  const [pending, setPending] = useState(enabled);
  const [error, setError] = useState("");
  const request = useRef(0);
  const scope = useRef("");
  const load = useCallback(async (page?: StreamPage) => {
    if (!enabled) return;
    const id = ++request.current;
    setPending(true);
    setError("");
    try {
      const site = page?.site ?? (await client.sites()).sites.find(item => item.host === host);
      if (!site) {
        if (id === request.current) setData(undefined);
        return;
      }
      const result = await client.replyQueue(site.did, page?.next);
      const entries = result.threads.flatMap(({ article, replies }) => replies.map(reply => ({article, reply})));
      const combined = new Map([...(page?.entries ?? []), ...entries].map(entry => [replyKey(entry), entry]));
      if (id === request.current) {
        setData({ site, entries: [...combined.values()], next: result.next === page?.next ? undefined : result.next,
          partial: (page?.partial ?? false) || result.threads.some(thread => thread.unavailable.length > 0) });
      }
    } catch (reason) {
      if (id === request.current) setError(reason instanceof Error ? reason.message : "Couldn't load article replies.");
    } finally {
      if (id === request.current) setPending(false);
    }
  }, [client, enabled, host]);
  useEffect(() => {
    scope.current = enabled ? host : "";
    setData(undefined);
    setError("");
    setPending(enabled);
    if (enabled) void load();
    return () => { request.current++; };
  }, [enabled, host, load]);
  const current = data?.site.host === host && enabled ? data : undefined;
  return {
    data: current, pending: enabled && pending, error: enabled ? error : "",
    load: () => void load(),
    loadMore: () => { if (current?.next && !pending) void load(current); },
    onHandled(entry: StreamReply, handled: boolean) {
      if (scope.current !== host) return;
      setData(previous => !previous || previous.site.host !== host ? previous : {
        ...previous, entries: previous.entries.map(item => replyKey(item) === replyKey(entry) ? { ...item, reply: { ...item.reply, handled } } : item),
      });
    },
  };
}

export function InlineArticleReply({ entry, site, client, onHandled }: {
  entry: StreamReply; site: InsightSite; client: InsightsClient; onHandled: (handled: boolean) => void;
}) {
  const [composing, setComposing] = useState(false);
  return <ul className="ss-inline-reply" style={{ listStyle: "none", padding: 0, margin: 0 }}>
    <ReplyItem reply={entry.reply} site={site} client={client} rkey={entry.article.rkey}
      composing={composing} onCompose={setComposing} onHandled={onHandled}
      context={<p style={{ margin: "0 0 .35rem" }}>Reply to <a href={entry.article.url}>{entry.article.title}</a></p>} />
  </ul>;
}
