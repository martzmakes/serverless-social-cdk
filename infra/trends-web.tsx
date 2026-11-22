import { useEffect, useMemo, useRef, useState } from "react";
import { type InsightDays, type InsightSite, type InsightsClient, type TrendItem, type TrendKind, type TrendPage } from "./insights";

const number = new Intl.NumberFormat();
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const colors = ["#8fc9ff", "#9de1bd", "#dabaff"];
const sortOptions = {
  total: { ascending: "Fewest first", descending: "Most first" },
  publishedAt: { ascending: "Oldest first", descending: "Newest first" },
  title: { ascending: "Title A–Z", descending: "Title Z–A" },
} as const;
type SortColumn = keyof typeof sortOptions;
type Direction = "ascending" | "descending";
type Sort = { column: SortColumn; direction: Direction };
type TrendRow = { item: TrendItem; total?: number; publishedAt: number };
const batchPages = 5;

const css = `
.ss-trends{display:grid;gap:1rem;margin-block:1rem}
.ss-trends .trend-actions,.ss-trends .trend-top,.ss-trends .trend-legend{display:flex;align-items:center;gap:.55rem .9rem;flex-wrap:wrap}
.ss-trends .trend-actions,.ss-trends .trend-top{justify-content:space-between}
.ss-trends .trend-actions>div{display:flex;gap:.5rem;flex-wrap:wrap}
.ss-trends label{display:grid;gap:.25rem;font-size:.875rem}
.ss-trends button,.ss-trends select{font:inherit;color:inherit;border:1px solid var(--mw-line,#465874);border-radius:.45rem;background:var(--mw-card,#172437);padding:.4rem .6rem}
.ss-trends button{cursor:pointer}.ss-trends button:disabled{opacity:.55;cursor:default}
.ss-trends button[aria-pressed=true]{background:#243852;border-color:#769cc8}
.ss-trends .trend-card,.ss-trends .trend-list{min-width:0;border:1px solid var(--mw-line,#425570);border-radius:.7rem;background:var(--mw-card,#141e2f)}
.ss-trends .trend-card{padding:clamp(.8rem,2vw,1.35rem)}
.ss-trends h2{margin:0;font-size:1.25rem;letter-spacing:-.02em}
.ss-trends p{margin:.39rem 0}
.ss-trends small,.ss-trends .trend-dates{color:var(--mw-muted,#b6c6da)}
.ss-trends .trend-total{font-size:1.4rem;font-weight:750}
.ss-trends canvas{display:block;width:100%;height:2.15rem}
.ss-trends .trend-card canvas{height:clamp(8rem,20vh,14rem);margin-top:.6rem}
.ss-trends .trend-dates{display:flex;justify-content:space-between;font-size:.83rem}
.ss-trends .trend-legend{padding-top:.55rem;font-size:.85rem}
.ss-trends .trend-legend i{display:inline-block;width:.63rem;height:.63rem;margin-right:.3rem;border-radius:50%}
.ss-trends table{width:100%;border-collapse:collapse;text-align:left}
.ss-trends th,.ss-trends td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid var(--mw-line,#425570)}
.ss-trends th{color:var(--mw-muted,#b6c6da);font-size:.86rem}
.ss-trends th button.trend-sort-heading{padding:.2rem 0;border:0;background:transparent;text-align:left;font-weight:inherit}
.ss-trends .trend-sort-heading:hover{text-decoration:underline}
.ss-trends th[aria-sort] .trend-sort-heading{color:var(--mw-text,#edf4ff)}
.ss-trends .trend-compact-sort{display:none}
.ss-trends td{vertical-align:middle;color:inherit;overflow-wrap:anywhere}
.ss-trends td:first-child{width:40%}.ss-trends td:last-child{width:1%}
.ss-trends td:last-child button{white-space:nowrap}
.ss-trends td.trend-spark{min-width:7rem;width:22%}
.ss-trends .trend-link{padding:0;border:0;background:transparent;text-align:left;text-decoration:underline;color:#bedaff;font-weight:640}
.ss-trends .trend-mobile-date{display:none}
@media(max-width:1000px){
  .ss-trends .trend-date-cell{display:none}.ss-trends .trend-mobile-date{display:block}
  .ss-trends .trend-compact-sort{display:grid}
}
@media(max-width:590px){
  .ss-trends table,.ss-trends tbody,.ss-trends tr,.ss-trends td{display:block;width:auto!important}
  .ss-trends thead{display:none}
  .ss-trends tr{padding:.55rem .65rem;border-bottom:1px solid var(--mw-line,#425570)}
  .ss-trends td{padding:.2rem 0;border:0}
  .ss-trends td.trend-spark canvas{width:min(100%,14rem)}
  .ss-trends .trend-date-cell{display:none}
  .ss-trends td:last-child button{white-space:normal}
}
`;

function metricValue(series: (number | null)[], kind: TrendKind) {
  const observed = series.filter((value): value is number => value !== null);
  if (!observed.length) return undefined;
  return kind === "article" ? observed.reduce((sum, value) => sum + value, 0) : observed.at(-1);
}

export function sortTrendRows(items: TrendItem[], kind: TrendKind, { column, direction }: Sort): TrendRow[] {
  const multiplier = direction === "ascending" ? 1 : -1;
  return items.map(item => ({
    item, total: metricValue(item.values, kind), publishedAt: Date.parse(item.publishedAt),
  })).sort((a, b) => {
    if (column === "title") return multiplier * a.item.title.localeCompare(b.item.title);
    const left = a[column] ?? NaN;
    const right = b[column] ?? NaN;
    if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
    if (!Number.isFinite(right)) return -1;
    return multiplier * (left - right);
  });
}

function formatDay(day: string) {
  return Number.isFinite(Date.parse(day)) ? date.format(new Date(day)) : "";
}

function Sparkline({ plots, label, large = false }: { plots: (number | null)[][]; label: string; large?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    function draw() {
      const { width, height } = canvas!.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      const ctx = canvas!.getContext("2d");
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      const margin = large ? 8 : 3;
      const floor = height - margin;
      const max = Math.max(1, ...plots.flat().filter((value): value is number => value !== null));
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#526781";
      for (const level of large ? [0, .5, 1] : [0]) {
        const y = floor - level * (floor - margin);
        ctx.beginPath();
        ctx.moveTo(margin, y);
        ctx.lineTo(width - margin, y);
        ctx.stroke();
      }
      plots.forEach((series, i) => {
        ctx.strokeStyle = colors[i];
        ctx.fillStyle = colors[i];
        ctx.lineWidth = 2;
        let previous = false;
        ctx.beginPath();
        for (let d = 0; d < series.length; d++) {
          const value = series[d];
          if (value === null) { previous = false; continue; }
          const x = margin + d / Math.max(1, series.length - 1) * (width - 2 * margin);
          const y = floor - value / max * (floor - margin);
          if (previous) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          ctx.fillRect(x - 1, y - 1, 2, 2);
          previous = true;
        }
        ctx.stroke();
      });
    }
    const resize = new ResizeObserver(draw);
    resize.observe(canvas);
    draw();
    return () => resize.disconnect();
  }, [plots, large]);
  return <canvas ref={ref} role="img" aria-label={label} />;
}

function combinePages(base: TrendPage | undefined, page: TrendPage): TrendPage {
  if (!base) return page;
  const byKey = new Map(base.items.map(item => [item.rkey, item]));
  for (const item of page.items) {
    // Dates can turn over between paginated requests. Keep all rows on the
    // original range, filling days outside the later response with nulls.
    const values = new Map(page.days.map((day, i) => [day, item.values[i]]));
    byKey.set(item.rkey, { ...item, values: base.days.map(day => values.get(day) ?? null) });
  }
  return { days: base.days, items: [...byKey.values()], next: page.next };
}

export function WorkspaceTrends({ client, site, days, setDays, onOpenArticle }: {
  client: InsightsClient; site: InsightSite; days: InsightDays; setDays: (days: InsightDays) => void;
  onOpenArticle: (item?: TrendItem) => void;
}) {
  const [kind, setKind] = useState<TrendKind>("article");
  const [sort, setSort] = useState<Sort>({ column: "total", direction: "descending" });
  const [selected, setSelected] = useState<string[]>([]);
  const [data, setData] = useState<TrendPage>();
  const [more, setMore] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { did } = site;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (!more) setData(undefined);
    async function load() {
      let cursor = more;
      let loaded: TrendPage | undefined;
      for (let count = 0; count < batchPages && active; count++) {
        const page = await client.trends(did, kind, days, cursor);
        if (!Array.isArray(page.items) || !Array.isArray(page.days)) throw new Error("Content trends are unavailable on this deployment.");
        loaded = combinePages(loaded, page);
        if (page.next === cursor) loaded.next = undefined;
        cursor = loaded.next;
        if (!cursor) break;
      }
      if (active && loaded) setData(previous => combinePages(more ? previous : undefined, loaded!));
    }
    void load().catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load content trends.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, did, kind, days, more, attempt]);

  const articles = kind === "article";
  const metric = articles ? "website views" : "Bluesky interactions";
  const metricHeading = articles ? "Views" : "Interactions";
  const rows = useMemo(() => sortTrendRows(data?.items ?? [], kind, sort), [data, sort, kind]);
  const measured = rows.filter(row => row.total !== undefined);
  const overall = data?.days.map((_, day) => {
    const values = measured.map(({ item }) => item.values[day]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }) ?? [];
  const total = metricValue(overall, kind);
  const overlays = selected.flatMap(key => measured.find(row => row.item.rkey === key)?.item ?? []);
  const names = ["Overall", ...overlays.map(item => item.title)];
  const complete = !loading && !data?.next;

  function changeKind(next: TrendKind) {
    if (next === kind) return;
    setKind(next);
    setSelected([]);
    setMore(undefined);
    onOpenArticle(undefined);
  }

  function columnHeading(column: SortColumn, title: string, className?: string) {
    const current = sort.column === column ? sort.direction : undefined;
    const next = current ? (current === "ascending" ? "descending" : "ascending")
      : column === "title" ? "ascending" : "descending";
    return <th scope="col" className={className} aria-sort={current}>
      <button className="trend-sort-heading" type="button" aria-label={`Sort by ${title.toLowerCase()}, ${next}`}
        onClick={() => setSort({ column, direction: next })}>
        {title} <span aria-hidden="true">{current === "ascending" ? "↑" : current === "descending" ? "↓" : "↕"}</span>
      </button>
    </th>;
  }

  return <div className="ss-trends">
    <style>{css}</style>
    <div className="trend-actions">
      <div role="group" aria-label="Content type">
        <button type="button" aria-pressed={articles} onClick={() => changeKind("article")}>Articles</button>
        <button type="button" aria-pressed={!articles} onClick={() => changeKind("post")}>Short posts</button>
      </div>
      <div>
        <label>Date range<select value={days} onChange={event => { setMore(undefined); setDays(Number(event.target.value) as InsightDays); }}>
          {[7, 30, 90].map(range => <option key={range} value={range}>Last {range} days</option>)}
        </select></label>
        <label className="trend-compact-sort">Sort by
          <select value={`${sort.column}:${sort.direction}`} onChange={event => {
            const [column, direction] = event.target.value.split(":") as [SortColumn, Direction];
            setSort({ column, direction });
          }}>
          {(Object.keys(sortOptions) as SortColumn[]).map(column =>
            <optgroup key={column} label={{ total: metricHeading, publishedAt: "Published", title: "Title" }[column]}>
              {(["descending", "ascending"] as const).map(direction => (
                <option key={direction} value={`${column}:${direction}`}>
                  {column === "total" ? `${metricHeading} · ` : ""}{sortOptions[column][direction]}
                </option>
              ))}
            </optgroup>)}
        </select></label>
      </div>
    </div>
    {loading && <p role="status">Loading content trends…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {data && <>
      <section className="trend-card" aria-label="Overall trend">
        <div className="trend-top"><div><h2>Overall trend</h2>
          <small>{measured.length} of {rows.length} {articles ? "articles" : "short posts"} with history{complete ? "" : " on the loaded pages"}</small></div>
          {total !== undefined && <div className="trend-total">{number.format(total)} {metric}</div>}</div>
        {total === undefined ? <p>No tracked history in this date range.</p> : <>
          <Sparkline large plots={[overall, ...overlays.map(item => item.values)]}
            label={`Overall ${metric}. ${number.format(total)} ${articles ? "recorded in" : "on the latest measured day in"} the last ${days} days. ${overlays.length} overlaid trends.`} />
          <div className="trend-dates"><span>{formatDay(data.days[0])}</span><span>{formatDay(data.days.at(-1) ?? "")} UTC</span></div>
          <div className="trend-legend">{names.map((name, i) => <span key={i}><i aria-hidden="true" style={{ background: colors[i] }} />{name}</span>)}</div>
          <p><small>{articles ? "CloudFront logs can arrive late." : "Daily snapshots of likes, reposts, and replies on Bluesky."} Add up to two individual trends from the list.</small></p>
        </>}
      </section>
      {rows.length ? <div className="trend-list"><table>
        <thead><tr>{columnHeading("title", "Title")}{columnHeading("publishedAt", "Published", "trend-date-cell")}
          {columnHeading("total", metricHeading)}<th scope="col">{days}-day trend</th><th scope="col">Overall chart</th></tr></thead>
        <tbody>{rows.map(({item, total: value}) => {
          const isSelected = selected.includes(item.rkey);
          const day = formatDay(item.publishedAt);
          return <tr key={item.rkey}><td>{articles
            ? <button className="trend-link" type="button" onClick={() => onOpenArticle(item)}>{item.title}</button>
            : <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>}
            <small className="trend-mobile-date">{day}</small></td><td className="trend-date-cell">{day}</td>
            <td><strong>{value === undefined ? "—" : number.format(value)}</strong></td>
            <td className="trend-spark">{value === undefined ? <small>No history</small>
              : <Sparkline plots={[item.values]} label={`${item.title}. ${days}-day trend. ${number.format(value)} ${metric}.`} />}</td>
            <td><button type="button" aria-pressed={isSelected} aria-label={`${isSelected ? "Remove" : "Add"} trend for ${item.title}`}
              disabled={value === undefined || (!isSelected && overlays.length >= 2)}
              onClick={() => setSelected(previous => isSelected ? previous.filter(key => key !== item.rkey) : [...previous.filter(key => overlays.some(row => row.rkey === key)), item.rkey])}>
              {isSelected ? "Remove trend" : "Add trend"}
            </button></td></tr>;
        })}</tbody>
      </table></div> : <p>No published {articles ? "articles" : "short posts"} found.</p>}
      {data.next && <button type="button" disabled={loading} onClick={() => setMore(data.next)}>Load more {articles ? "articles" : "short posts"}</button>}
    </>}
  </div>;
}
