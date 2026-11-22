import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEVICES, SOURCES,
  type InsightDays, type InsightSite, type InsightsClient, type SiteOverview as Overview, type ViewTotals,
} from "./insights";

const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const regions = (() => {
  try { return new Intl.DisplayNames(undefined, { type: "region" }); } catch { return undefined; }
})();
const ranges = [7, 30, 90] as const;

/** Page kinds in a fixed categorical order (validated against light and dark surfaces). */
const SERIES = [
  { key: "articles", label: "Articles" },
  { key: "home", label: "Home page" },
  { key: "posts", label: "Short-post pages" },
] as const satisfies readonly { key: keyof ViewTotals; label: string }[];

const css = `
.ss-overview{--ov-s1:#2a78d6;--ov-s2:#eb6834;--ov-s3:#1baf7a;--ov-text:inherit;--ov-muted:var(--mw-muted,#5d6675);
  --ov-line:var(--mw-line,rgba(127,127,127,.35));--ov-card:var(--mw-card,transparent);--ov-surface:var(--mw-card,#fff);
  display:grid;gap:1.25rem;margin-bottom:1.75rem;min-width:0}
@media (prefers-color-scheme:dark){.ss-overview{--ov-s1:#3987e5;--ov-s2:#d95926;--ov-s3:#199e70;--ov-muted:var(--mw-muted,#b7c5dc);--ov-surface:var(--mw-card,#131d2d)}}
.ss-overview[data-theme=dark]{--ov-s1:#3987e5;--ov-s2:#d95926;--ov-s3:#199e70;--ov-muted:var(--mw-muted,#b7c5dc);--ov-surface:var(--mw-card,#131d2d)}
.ss-overview h2,.ss-overview h3{margin:0}
.ss-overview .ov-head{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;align-items:center;justify-content:space-between}
.ss-overview .ov-range{display:inline-flex;border:1px solid var(--ov-line);border-radius:999px;padding:2px}
.ss-overview .ov-range button{border:0;background:transparent;color:inherit;font:inherit;padding:.3rem .8rem;border-radius:999px;cursor:pointer}
.ss-overview .ov-range button[aria-pressed=true]{background:var(--ov-line);font-weight:650}
.ss-overview .ov-card{border:1px solid var(--ov-line);border-radius:12px;padding:1rem;background:var(--ov-card);min-width:0}
.ss-overview .ov-tiles{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,10.5rem),1fr))}
.ss-overview .ov-tile{display:grid;gap:.2rem}
.ss-overview .ov-tile span{color:var(--ov-muted);font-size:.86rem}
.ss-overview .ov-tile strong{font-size:1.7rem;line-height:1.15;font-variant-numeric:tabular-nums}
.ss-overview .ov-tile small{color:var(--ov-muted);font-variant-numeric:tabular-nums}
.ss-overview .ov-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))}
.ss-overview .ov-wide{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))}
.ss-overview .ov-legend{display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin:.6rem 0;padding:0;list-style:none;font-size:.88rem;color:var(--ov-muted)}
.ss-overview .ov-legend i{display:inline-block;width:.7rem;height:.7rem;border-radius:3px;margin-right:.35rem;vertical-align:-.05rem}
.ss-overview .ov-chart{position:relative}
.ss-overview .ov-chart svg{display:block;max-width:100%;overflow:visible}
.ss-overview .ov-axis{fill:var(--ov-muted);font-size:11px;font-variant-numeric:tabular-nums}
.ss-overview .ov-tip{position:absolute;top:0;pointer-events:none;background:var(--ov-surface);border:1px solid var(--ov-line);
  border-radius:8px;padding:.5rem .65rem;font-size:.85rem;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.25);z-index:1}
.ss-overview .ov-tip div{display:flex;justify-content:space-between;gap:1rem}
.ss-overview .ov-tip i{display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.35rem}
.ss-overview .ov-hit{fill:transparent;cursor:crosshair;outline:none}
.ss-overview .ov-hit:focus-visible{stroke:currentColor;stroke-width:1}
.ss-overview ol,.ss-overview ul.ov-bars{margin:0;padding:0;list-style:none;display:grid;gap:.7rem}
.ss-overview .ov-row{display:flex;justify-content:space-between;gap:.75rem;align-items:baseline}
.ss-overview .ov-row > :first-child{min-width:0;overflow-wrap:anywhere}
.ss-overview .ov-row strong{font-variant-numeric:tabular-nums;white-space:nowrap}
.ss-overview .ov-bar{height:4px;border-radius:2px;margin-top:.3rem;background:var(--ov-s1)}
.ss-overview .ov-meta{color:var(--ov-muted);font-size:.85rem}
.ss-overview .ov-note{color:var(--ov-muted);font-size:.85rem;margin:0}
.ss-overview table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.ss-overview th,.ss-overview td{text-align:right;padding:.3rem .5rem;border-bottom:1px solid var(--ov-line)}
.ss-overview th:first-child,.ss-overview td:first-child{text-align:left}
.ss-overview a{color:inherit}
`;

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not load the site overview.";
}

const sum = (t: ViewTotals) => t.articles + t.home + t.posts;

function change(now: number, before: number, days: number) {
  if (!before) return now ? `New this period` : `No views in either ${days}-day period`;
  const pct = Math.round((now - before) / before * 100);
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "■";
  return `${arrow} ${pct > 0 ? "+" : ""}${pct}% vs previous ${days} days`;
}

function countryName(code: string) {
  if (code === "ZZ") return "Unknown";
  try { return regions?.of(code) ?? code; } catch { return code; }
}

/** Site-wide analytics: totals vs the previous period, daily mix, top content and audience. */
export function SiteOverview({ client, site, days, setDays, dark = false }: {
  client: InsightsClient; site: InsightSite; days: InsightDays; setDays: (days: InsightDays) => void; dark?: boolean;
}) {
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void client.overview(site.did, days).then(result => { if (active) setData(result); })
      .catch(reason => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [client, site.did, days, attempt]);
  const stale = data && data.days.length !== days;

  return (
    <section className="ss-overview" aria-label="Site overview" data-theme={dark ? "dark" : undefined} aria-busy={!data || stale}>
      <style>{css}</style>
      <div className="ov-head">
        <h2>Site overview</h2>
        <div className="ov-range" role="group" aria-label="Date range">
          {ranges.map(range => (
            <button key={range} type="button" aria-pressed={days === range} onClick={() => setDays(range)}>{range} days</button>
          ))}
        </div>
      </div>
      {error ? <p role="alert">{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>
        : !data ? <p role="status">Loading site overview…</p>
        : <OverviewBody data={data} days={data.days.length} />}
    </section>
  );
}

function previousStart(data: Overview) {
  return new Date(Date.parse(data.days[0]) - data.days.length * 86_400_000).toISOString().slice(0, 10);
}

function OverviewBody({ data, days }: { data: Overview; days: number }) {
  const total = sum(data.totals);
  const before = sum(data.previous);
  const preFilter = data.cleanFrom && data.days[0] < data.cleanFrom;
  // Don't compare against days counted with the older, looser filter.
  const comparable = !data.cleanFrom || previousStart(data) >= data.cleanFrom;
  const vs = (now: number, prior: number) => comparable ? change(now, prior, days)
    : `Comparison available ${shortDate.format(new Date(Date.parse(data.cleanFrom!) + (2 * days - 1) * 86_400_000))}`;
  return <>
    <div className="ov-tiles">
      <Tile label="Human page views" value={total} detail={vs(total, before)} />
      <Tile label="Article views" value={data.totals.articles} detail={vs(data.totals.articles, data.previous.articles)} />
      <Tile label="Home page" value={data.totals.home} detail={vs(data.totals.home, data.previous.home)} />
      <Tile label="Short-post pages" value={data.totals.posts} detail={vs(data.totals.posts, data.previous.posts)} />
      {data.followers && <Tile label="Bluesky followers" value={data.followers.count}
        detail={`${data.followers.change >= 0 ? "+" : ""}${number.format(data.followers.change)} this period`} />}
    </div>
    <DailyChart data={data} />
    <p className="ov-note">
      Counted from CloudFront logs, with no tracker or cookie. {number.format(data.automated)} automated requests to these pages
      (crawlers, link previews, scripts) were left out.
      {preFilter && <> Days before {shortDate.format(new Date(data.cleanFrom!))} were counted with an older filter and may include scripted traffic.</>}
    </p>
    <div className="ov-wide">
      <TopArticles data={data} comparable={comparable} />
      <TopPosts data={data} />
    </div>
    <div className="ov-grid">
      <Bars title="Where readers came from" rows={(Object.keys(SOURCES) as (keyof typeof SOURCES)[])
        .flatMap(key => data.sources[key] ? [{ label: SOURCES[key], value: data.sources[key]! }] : [])} />
      <Bars title="Top referring sites" rows={data.referrers.map(row => ({ label: row.host === "direct" ? "Direct or unavailable" : row.host, value: row.views }))} />
      <Bars title="Countries" note="Approximate: the country of the CloudFront location that served the page."
        rows={data.countries.slice(0, 12).map(row => ({ label: countryName(row.code), value: row.views }))} />
      <Bars title="Nearest cities" note="CloudFront locations that served readers."
        rows={data.cities.map(row => {
          const country = countryName(row.country);
          return { label: !row.city ? row.code : row.city === country ? row.city : `${row.city}, ${country}`, value: row.views };
        })} />
      <Bars title="Devices" rows={(Object.keys(DEVICES) as (keyof typeof DEVICES)[])
        .flatMap(key => data.devices[key] ? [{ label: DEVICES[key], value: data.devices[key]! }] : [])} />
    </div>
  </>;
}

function Tile({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="ov-card ov-tile"><span>{label}</span><strong>{number.format(value)}</strong><small>{detail}</small></div>;
}

function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * step) return m * step;
  return 10 * step;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function DailyChart({ data }: { data: Overview }) {
  const [active, setActive] = useState<number>();
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = 208, left = 34, bottom = 22, top = 8;
  const max = useMemo(() => niceMax(Math.max(0, ...data.daily.map(sum))), [data]);
  const n = data.daily.length;
  const slot = (W - left) / n;
  const bar = Math.max(2, Math.min(28, slot - (n > 45 ? 1 : 2)));
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(n / 6);
  const point = active !== undefined ? data.daily[active] : undefined;
  return (
    <div className="ov-card">
      <h3>Human page views by day</h3>
      <ul className="ov-legend" aria-label="Legend">
        {SERIES.map((s, i) => <li key={s.key}><i style={{ background: `var(--ov-s${i + 1})` }} />{s.label}</li>)}
      </ul>
      <div className="ov-chart" ref={ref} onMouseLeave={() => setActive(undefined)}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
          aria-label={`Daily human page views, ${shortDate.format(new Date(data.days[0]))} to ${shortDate.format(new Date(data.days[n - 1]))} UTC. Daily values are in the table below.`}>
          {ticks.map(t => <g key={t}>
            <line x1={left} x2={W} y1={y(t)} y2={y(t)} stroke="var(--ov-line)" strokeWidth={1} />
            <text className="ov-axis" x={left - 6} y={y(t) + 4} textAnchor="end">{t >= 10_000 ? compact.format(t) : number.format(t)}</text>
          </g>)}
          {data.daily.map((row, i) => {
            const x = left + i * slot + (slot - bar) / 2;
            let base = 0;
            const segments = SERIES.map((s, k) => {
              const value = row[s.key];
              if (!value) return null;
              const y0 = y(base), y1 = y(base + value);
              base += value;
              // 2px surface gap between stacked segments.
              const h = Math.max(1, y0 - y1 - (base > value ? 2 : 0));
              return <rect key={s.key} x={x} y={y1} width={bar} height={h} rx={Math.min(2, bar / 3)} fill={`var(--ov-s${k + 1})`}
                opacity={active === undefined || active === i ? 1 : .45} />;
            });
            return <g key={row.day}>
              {segments}
              {i % labelEvery === 0 && <text className="ov-axis" x={x + bar / 2} y={H - 6} textAnchor="middle">{shortDate.format(new Date(row.day))}</text>}
              <rect className="ov-hit" x={left + i * slot} y={0} width={slot} height={H - bottom} tabIndex={0}
                aria-label={`${longDate.format(new Date(row.day))}: ${number.format(sum(row))} views`}
                onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(undefined)} />
            </g>;
          })}
        </svg>
        {point && active !== undefined && (
          <div className="ov-tip" role="status" style={{
            left: `clamp(0px, calc(${left + (active + .5) * slot}px - 5.5rem), calc(100% - 11rem))`,
          }}>
            <strong>{longDate.format(new Date(point.day))}</strong>
            {SERIES.map((s, k) => <div key={s.key}><span><i style={{ background: `var(--ov-s${k + 1})` }} />{s.label}</span><span>{number.format(point[s.key])}</span></div>)}
            <div><span>Total</span><strong>{number.format(sum(point))}</strong></div>
          </div>
        )}
      </div>
      <details>
        <summary>Daily table</summary>
        <table>
          <thead><tr><th scope="col">Day (UTC)</th>{SERIES.map(s => <th key={s.key} scope="col">{s.label}</th>)}<th scope="col">Total</th></tr></thead>
          <tbody>{[...data.daily].reverse().map(row => (
            <tr key={row.day}><td>{shortDate.format(new Date(row.day))}</td>{SERIES.map(s => <td key={s.key}>{number.format(row[s.key])}</td>)}<td>{number.format(sum(row))}</td></tr>
          ))}</tbody>
        </table>
      </details>
    </div>
  );
}

function TopArticles({ data, comparable }: { data: Overview; comparable: boolean }) {
  const max = Math.max(1, ...data.topArticles.map(a => a.views));
  return (
    <section className="ov-card">
      <h3>Top articles</h3>
      <p className="ov-meta">{number.format(data.articleCount)} published · views this period{comparable ? ", with the previous period" : ""}</p>
      {data.topArticles.length ? <ol>
        {data.topArticles.map(article => (
          <li key={article.rkey}>
            <div className="ov-row"><a href={article.url}>{article.title}</a><strong>{number.format(article.views)}</strong></div>
            <div className="ov-bar" style={{ width: `${article.views / max * 100}%` }} aria-hidden="true" />
            {comparable && <div className="ov-meta">{article.previous ? `${number.format(article.previous)} the period before` : "No views the period before"}</div>}
          </li>
        ))}
      </ol> : <p className="ov-note">No article views in this period yet.</p>}
    </section>
  );
}

function TopPosts({ data }: { data: Overview }) {
  return (
    <section className="ov-card">
      <h3>Short posts</h3>
      <p className="ov-meta">Page loads on this site and Bluesky likes, reposts and replies gained this period</p>
      {data.topPosts.length ? <ol>
        {data.topPosts.map(post => (
          <li key={post.rkey}>
            <div className="ov-row">
              <a href={post.url}>{post.text.length > 110 ? post.text.slice(0, 110).trimEnd() + "…" : post.text}</a>
            </div>
            <div className="ov-meta">
              {number.format(post.views)} page {post.views === 1 ? "view" : "views"}
              {!!post.engagement && <> · {(post.engagementGain ?? 0) >= 0 ? "+" : ""}{number.format(post.engagementGain ?? 0)} engagement ({number.format(post.engagement)} total)</>}
              {post.publishedAt && <> · {shortDate.format(new Date(post.publishedAt))}</>}
            </div>
          </li>
        ))}
      </ol> : <p className="ov-note">No short-post activity in this period yet.</p>}
    </section>
  );
}

function Bars({ title, rows, note }: { title: string; rows: { label: string; value: number }[]; note?: string }) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((n, row) => n + row.value, 0);
  const max = sorted[0]?.value ?? 1;
  return (
    <section className="ov-card">
      <h3>{title}</h3>
      {note && <p className="ov-meta">{note}</p>}
      {sorted.length ? <ul className="ov-bars" style={{ marginTop: ".75rem" }}>
        {sorted.map(row => (
          <li key={row.label}>
            <div className="ov-row"><span>{row.label}</span>
              <strong>{number.format(row.value)} <span className="ov-meta">{Math.round(row.value / total * 100)}%</span></strong></div>
            <div className="ov-bar" style={{ width: `${row.value / max * 100}%` }} aria-hidden="true" />
          </li>
        ))}
      </ul> : <p className="ov-note">No data for this period.</p>}
    </section>
  );
}
