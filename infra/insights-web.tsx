export { ArticleReplyQueue } from "./reply-queue-web";
export { InlineArticleReply, useArticleStream } from "./article-stream-web";
export { SiteSharingSettings, WorkspaceSettings } from "./site-sharing-web";
import { ReplyItem } from "./article-reply-web";
import { WorkspaceTrends } from "./trends-web";
import { SiteOverview } from "./overview-web";
export { SiteOverview } from "./overview-web";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DEVICES, SHARE_SOURCES, SOURCES, taggedArticleUrl,
  type ArticleDistribution, type ArticleInsights, type ArticleReplies, type ArticleReply,
  type InsightArticle, type InsightDays, type InsightSite, type InsightsClient,
} from "./insights";

const number = new Intl.NumberFormat();
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const ranges = [7, 30, 90] as const;
const layout: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center" };
const grid: CSSProperties = { display: "grid", gap: "1.25rem", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))" };
const field: CSSProperties = { display: "grid", gap: ".35rem", minWidth: 0 };
const control: CSSProperties = { minWidth: 0, maxWidth: "100%", padding: ".45rem", font: "inherit" };
const border: CSSProperties = { border: "1px solid currentColor", borderRadius: 12, padding: "1rem" };

const regions = (() => {
  try { return new Intl.DisplayNames(undefined, { type: "region" }); } catch { return undefined; }
})();
function regionName(code: string) {
  if (code === "ZZ") return "Unknown";
  try { return regions?.of(code) ?? code; } catch { return code; }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not load analytics.";
}

export function PostInsights({ client, preferredHost, accent = "#4476e7", workspace = false, initialArticle }: {
  client: InsightsClient; preferredHost?: string; accent?: string; workspace?: boolean; initialArticle?: { did: string; rkey: string };
}) {
  const [sites, setSites] = useState<InsightSite[]>();
  const [did, setDid] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setSites(undefined);
    setError("");
    void client.sites().then(result => {
      if (!active) return;
      setSites(result.sites);
      setDid((result.sites.find(site => site.did === initialArticle?.did)
        ?? result.sites.find(site => site.host === preferredHost) ?? result.sites[0])?.did ?? "");
    }).catch(reason => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [client, preferredHost, attempt, initialArticle?.did]);
  const selectedSite = sites?.find(site => site.did === did);
  return (
    <section aria-label={workspace ? "Analytics" : "Post control room"} style={{ maxWidth: workspace ? "100%" : 880, margin: "auto", padding: workspace ? 0 : "clamp(1rem, 4vw, 2rem)", fontFamily: "system-ui", overflowWrap: "anywhere" }}>
      <h1 style={{ marginTop: 0 }}>{workspace ? "Analytics" : "Post control room"}</h1>
      {error ? (
        <><p role="alert">{error}</p><button onClick={() => setAttempt(n => n + 1)}>Retry</button></>
      ) : !sites ? <p role="status">Loading sites…</p> : sites.length === 0 ? (
        <p>No publishing sites are available for this account.</p>
      ) : (
        <>
          <label style={field}>Site
            <select style={control} value={did} onChange={event => setDid(event.target.value)}>
              {sites.map(site => <option key={site.did} value={site.did}>{site.host}</option>)}
            </select>
          </label>
          {selectedSite && (workspace ? <WorkspaceInsights key={did} client={client} site={selectedSite} accent={accent}
              initialRkey={initialArticle?.did === did ? initialArticle.rkey : undefined} />
            : <SiteArticles key={did} client={client} site={selectedSite} accent={accent} />)}
        </>
      )}
    </section>
  );
}

function WorkspaceInsights({ client, site, accent, initialRkey }: { client: InsightsClient; site: InsightSite; accent: string; initialRkey?: string }) {
  const [days, setDays] = useState<InsightDays>(30);
  const [selected, setSelected] = useState<InsightArticle>();
  const [detailError, setDetailError] = useState("");
  const detail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!initialRkey) return;
    let active = true;
    void client.article(site.did, initialRkey, 30).then(report => { if (active) setSelected(report.article); })
      .catch(reason => { if (active) setDetailError(message(reason)); });
    return () => { active = false; };
  }, [client, initialRkey, site.did]);
  useEffect(() => {
    if (!selected) return;
    detail.current?.focus({ preventScroll: true });
    detail.current?.scrollIntoView({ block: "start" });
  }, [selected]);
  return <>
    <SiteOverview client={client} site={site} days={days} setDays={setDays} dark />
    <WorkspaceTrends client={client} site={site} days={days} setDays={setDays} onOpenArticle={setSelected} />
    {detailError && !selected && <p role="alert">{detailError}</p>}
    {selected && <section ref={detail} tabIndex={-1} aria-label="Article analytics detail">
      <button type="button" onClick={() => setSelected(undefined)}>Close article report</button>
      <ArticleDetails key={selected.rkey} article={selected} client={client} site={site} days={days} accent={accent} />
    </section>}
  </>;
}

function ArticleDetails({ article, client, site, days, accent }: {
  article: InsightArticle; client: InsightsClient; site: InsightSite; days: InsightDays; accent: string;
}) {
  return <>
    <div style={{ marginBlock: "1.5rem" }}>
      <h2 style={{ marginBottom: ".5rem" }}>{article.title}</h2>
      <div style={layout}>
        <a href={article.url}>Open article</a>
        {article.blueskyUrl && <a href={article.blueskyUrl}>Open Bluesky post</a>}
      </div>
    </div>
    <ArticleConversation client={client} site={site} rkey={article.rkey} />
    <Distribution client={client} did={site.did} article={article} />
    <Report key={days} client={client} did={site.did} rkey={article.rkey} days={days} accent={accent} />
  </>;
}

function SiteArticles({ client, site, accent }: { client: InsightsClient; site: InsightSite; accent: string }) {
  const { did } = site;
  const [articles, setArticles] = useState<InsightArticle[]>([]);
  const [rkey, setRkey] = useState("");
  const [days, setDays] = useState<InsightDays>(30);
  const [after, setAfter] = useState<string>();
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void client.articles(did, after).then(result => {
      if (!active) return;
      setArticles(previous => after ? [...previous, ...result.articles] : result.articles);
      setRkey(key => key || result.articles[0]?.rkey || "");
      setNext(result.next);
    }).catch(reason => { if (active) setError(message(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, did, after, attempt]);
  const selectedArticle = articles.find(article => article.rkey === rkey);

  return (
    <>
      <div style={{ marginTop: "1.25rem" }}>
        <SiteOverview client={client} site={site} days={days} setDays={setDays} />
      </div>
      <div style={{ ...grid, marginTop: "1rem" }}>
        <label style={field}>Article
          <select style={control} value={rkey} onChange={event => setRkey(event.target.value)} disabled={!articles.length}>
            {!articles.length && <option value="">{loading ? "Loading articles…" : "No articles on this page"}</option>}
            {articles.map(article => <option key={article.rkey} value={article.rkey}>{article.title}</option>)}
          </select>
        </label>
        <label style={field}>Date range
          <select style={control} value={days} onChange={event => setDays(Number(event.target.value) as InsightDays)}>
            {ranges.map(range => <option key={range} value={range}>Last {range} days</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert">{error} <button onClick={() => setAttempt(n => n + 1)}>Retry</button></p>}
      {next && !error && <p><button disabled={loading} onClick={() => setAfter(next)}>Load more articles</button></p>}
      {!rkey && !next && !loading && !error && <p>Publish an article to start seeing its analytics here.</p>}
      {selectedArticle && <ArticleDetails key={rkey} article={selectedArticle} client={client} site={site} days={days} accent={accent} />}
    </>
  );
}

function Report({ client, did, rkey, days, accent }: {
  client: InsightsClient; did: string; rkey: string; days: InsightDays; accent: string;
}) {
  const [report, setReport] = useState<ArticleInsights>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReport(undefined);
    setError("");
    void client.article(did, rkey, days).then(result => {
      if (active) setReport(result);
    }).catch(reason => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [client, did, rkey, days, attempt]);

  if (error) return <p role="alert">{error} <button onClick={() => setAttempt(n => n + 1)}>Retry</button></p>;
  if (!report) return <p role="status">Loading article analytics…</p>;
  const max = Math.max(1, ...report.daily.map(row => row.views));
  const breakdown = <T extends string>(values: Partial<Record<T, number>>, labels: Record<T, string>) =>
    (Object.keys(labels) as T[]).flatMap(key => values[key] ? [{ label: labels[key], views: values[key]! }] : []);
  return (
    <>
      <section style={border} aria-label="Page views by day">
        <h3 style={{ marginTop: 0 }}><strong style={{ fontSize: "1.65rem" }}>{number.format(report.views)}</strong> page views</h3>
        <div aria-hidden="true" style={{ display: "flex", height: "6rem", gap: 2, alignItems: "end", borderBottom: "1px solid currentColor" }}>
          {report.daily.map(row => (
            <span key={row.day} title={`${row.day} UTC · ${number.format(row.views)} views`}
              style={{ flex: 1, background: accent, height: `${row.views / max * 100}%` }} />
          ))}
        </div>
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", marginBlock: ".5rem" }}>
          <span>{date.format(new Date(report.daily[0].day))}</span>
          <span>{date.format(new Date(report.daily[report.daily.length - 1].day))} UTC</span>
        </div>
        <details>
          <summary>Daily totals</summary>
          <ul>{report.daily.map(row => <li key={row.day}>{row.day} UTC · {number.format(row.views)}</li>)}</ul>
        </details>
        <p>Page requests classified as human, grouped by UTC day. CloudFront log delivery can lag.</p>
      </section>
      <p>{number.format(report.classifiedViews)} of {number.format(report.views)} views have source and device classifications.</p>
      <div style={grid}>
        <Breakdown title="Sources" rows={breakdown(report.sources, SOURCES)} accent={accent} />
        <Breakdown title="Devices" rows={breakdown(report.devices, DEVICES)} accent={accent} />
        <Breakdown title="Top referrer domains" rows={report.referrers.map(({ host, views }) => ({ label: host === "direct" ? SOURCES.direct : host, views }))} accent={accent} />
        {report.countries && <Breakdown title="Countries (approximate)" rows={report.countries.slice(0, 10).map(({ code, views }) => ({ label: regionName(code), views }))} accent={accent} />}
        {report.cities && <Breakdown title="Nearest CloudFront cities" rows={report.cities.map(({ code, city, views }) => ({ label: city ?? code, views }))} accent={accent} />}
      </div>
      <ShareLink url={report.article.url} />
    </>
  );
}

function Distribution({ client, did, article }: { client: InsightsClient; did: string; article: InsightArticle }) {
  const [data, setData] = useState<ArticleDistribution>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setData(undefined);
    void client.distribution(did, article.rkey).then(result => {
      if (active) setData(result);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [client, did, article.rkey, attempt]);

  if (failed) return <p role="alert">Couldn't load distribution. <button onClick={() => setAttempt(n => n + 1)}>Retry</button></p>;
  if (!data) return <p role="status">Loading distribution…</p>;
  return (
    <div style={{ ...grid, marginBottom: "1.25rem" }}>
      <section style={border}>
        <h3 style={{ marginTop: 0 }}>Distribution</h3>
        <p>Website · Published <time dateTime={article.publishedAt}>{date.format(new Date(article.publishedAt))}</time></p>
        <p><a href={data.activityPubUrl}>Open Fediverse article object</a></p>
        {article.blueskyUrl ? (
          data.bluesky ? (
            <>
              <p>Bluesky · {number.format(data.bluesky.likes)} likes · {number.format(data.bluesky.reposts)} reposts · {number.format(data.bluesky.replies)} replies</p>
              <small>Snapshot from {data.bluesky.day} UTC</small>
            </>
          ) : <p>Bluesky engagement is awaiting a snapshot.</p>
        ) : <p>Bluesky syndication is unavailable for this article.</p>}
      </section>
      <section style={border}>
        <h3 style={{ marginTop: 0 }}>Social card</h3>
        {data.socialCard ? (
          <>
            {data.socialCard.image && <img src={data.socialCard.image} alt={data.socialCard.imageAlt ?? ""} style={{ display: "block", width: "100%", maxHeight: "14rem", objectFit: "contain", borderRadius: 6, marginBottom: ".75rem" }} loading="lazy" referrerPolicy="no-referrer" />}
            <strong>{data.socialCard.title}</strong>
            {data.socialCard.description && <p>{data.socialCard.description}</p>}
          </>
        ) : <p>The published social card is unavailable.</p>}
      </section>
    </div>
  );
}

function replyKey(reply: ArticleReply) {
  return `${reply.network}:${reply.id}`;
}

function ArticleConversation({ client, site, rkey }: { client: InsightsClient; site: InsightSite; rkey: string }) {
  const { did } = site;
  const [data, setData] = useState<ArticleReplies>();
  const [after, setAfter] = useState<string>();
  const [open, setOpen] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const [composing, setComposing] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setFailed(false);
    void client.replies(did, rkey, after).then(page => {
      if (!active) return;
      setData(previous => {
        if (!after) return page;
        const replies = new Map(previous?.replies.map(reply => [replyKey(reply), reply]));
        for (const reply of page.replies) replies.set(replyKey(reply), reply);
        return {
          ...page,
          replies: [...replies.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
          unavailable: [...new Set([...(previous?.unavailable ?? []), ...page.unavailable])],
          next: page.next === after ? undefined : page.next,
        };
      });
    }).catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, did, rkey, after, open, attempt]);

  function setHandled(reply: ArticleReply, handled: boolean) {
    setData(previous => previous && {
      ...previous,
      replies: previous.replies.map(item => replyKey(item) === replyKey(reply) ? { ...item, handled } : item),
    });
  }

  const visible = data?.replies.filter(reply => Boolean(reply.handled) === showHandled) ?? [];

  return (
    <details style={{ ...border, marginBottom: "1.25rem" }} onToggle={event => {
      if (event.currentTarget.open) setOpen(true);
    }}>
      <summary>Article replies</summary>
      {data && (
        <div style={{ ...layout, marginBlock: ".75rem" }} role="group" aria-label="Reply status">
          <button type="button" aria-pressed={!showHandled} onClick={() => { setShowHandled(false); setComposing(undefined); }}>Open</button>
          <button type="button" aria-pressed={showHandled} onClick={() => { setShowHandled(true); setComposing(undefined); }}>Handled</button>
          <button type="button" disabled={loading} onClick={() => { setAfter(undefined); setAttempt(value => value + 1); }}>Refresh replies</button>
        </div>
      )}
      {loading && <p role="status">Loading replies…</p>}
      {(failed || !!data?.unavailable.length) && (
        <p role="alert">
          {failed ? "Couldn't load replies." : `Couldn't load replies from ${data?.unavailable.join(" and ")}.`}{' '}
          {!data && <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Retry</button>}
        </p>
      )}
      {!!visible.length && (
        <ul style={{ paddingLeft: "1rem" }}>
          {visible.map(reply => (
            <ReplyItem key={replyKey(reply)} reply={reply} site={site} client={client} rkey={rkey}
              composing={composing === replyKey(reply)} onCompose={active => setComposing(active ? replyKey(reply) : undefined)}
              onHandled={handled => setHandled(reply, handled)} />
          ))}
        </ul>
      )}
      {data && !visible.length && !data.unavailable.length && !loading && !failed &&
        <p>{showHandled ? "No handled replies to display." : "No open replies to display."}</p>}
      {data?.next && !failed && <button type="button" disabled={loading} onClick={() => setAfter(data.next)}>Load older Fediverse replies</button>}
    </details>
  );
}

function Breakdown({ title, rows, accent }: { title: string; rows: { label: string; views: number }[]; accent: string }) {
  const sorted = [...rows].sort((a, b) => b.views - a.views);
  const max = sorted[0]?.views ?? 1;
  return (
    <section style={border}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {sorted.length ? <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {sorted.map(row => (
          <li key={row.label} style={{ marginBlock: ".65rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{row.label}</span><strong>{number.format(row.views)}</strong>
            </div>
            <div aria-hidden="true" style={{ borderRadius: 3, height: 4, background: accent, width: `${row.views / max * 100}%` }} />
          </li>
        ))}
      </ul> : <p>No data for this period.</p>}
    </section>
  );
}

function ShareLink({ url }: { url: string }) {
  const [source, setSource] = useState<typeof SHARE_SOURCES[number]>("linkedin");
  const link = taggedArticleUrl(url, source);
  return (
    <section style={{ ...border, marginTop: "1.25rem" }}>
      <h3 style={{ marginTop: 0 }}>Create a tagged share link</h3>
      <p>Use a tagged link when sharing from an app that may omit the referrer.</p>
      <div style={grid}>
        <label style={field}>Share to
          <select style={control} value={source} onChange={event => setSource(event.target.value as typeof source)}>
            {SHARE_SOURCES.map(key => <option key={key} value={key}>{SOURCES[key]}</option>)}
          </select>
        </label>
        <label style={field}>Share link
          <input style={control} readOnly value={link} onFocus={event => event.currentTarget.select()} />
        </label>
      </div>
    </section>
  );
}
