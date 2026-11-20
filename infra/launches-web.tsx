import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ArticleDistribution, InsightArticle, InsightsClient, InsightSite } from "./insights";
import {
  fitsLaunchLimit, launchLength, launchLimit, launchLink, launchPlatforms,
  type ArticleLaunch, type LaunchChannel, type LaunchInputs, type LaunchesClient, type LaunchPlatform,
} from "./launches";

const platformNames = { bluesky: "Bluesky", fediverse: "ActivityPub" };
const stateNames = {
  draft: "Draft", failed: "Needs retry", posted: "Posted to the PDS",
  queued: "Federation queued", automatic: "Automatic syndication",
};
const css = `
.ss-launches{box-sizing:border-box;max-width:56rem;margin:auto;padding:clamp(1rem,4vw,2rem);font:inherit;overflow-wrap:anywhere}
.ss-launches h1{margin-top:0;line-height:1.14}
.ss-launches h2,.ss-launches h3,.ss-launches p{margin:0}
.ss-launches h2{font-size:1.32rem;line-height:1.22}
.ss-launches h3{font-size:1rem}
.ss-launches a{color:var(--ss-launch-link);text-underline-offset:.18em}
.ss-launches :is(button,input,select,textarea){box-sizing:border-box;font:inherit;color:inherit;border:1px solid color-mix(in srgb,currentColor 32%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);border-radius:.45rem;min-height:2.6rem;padding:.48rem .74rem;max-width:100%}
.ss-launches button{cursor:pointer}
.ss-launches button:disabled{cursor:default;opacity:.58}
.ss-launches :focus-visible{outline:2px solid var(--ss-launch-link);outline-offset:3px}
.ss-launches select option{background:Canvas;color:CanvasText}
.ss-launches textarea{min-height:8rem;width:100%;resize:vertical;display:block}
.ss-launches input[type=checkbox]{min-height:1rem;width:1rem;accent-color:var(--ss-launch-link)}
.ss-launches .launch-primary{font-weight:700;border-color:var(--ss-launch-link);background:color-mix(in srgb,var(--ss-launch-link) 18%,transparent)}
.ss-launches .launch-stack{display:grid;gap:.9rem;min-width:0}
.ss-launches .launch-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:.8rem}
.ss-launches .launch-picker{display:grid;min-width:0;gap:.3rem}
.ss-launches .launch-row{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem .8rem}
.ss-launches .launch-row label{display:flex;align-items:center;gap:.4rem}
.ss-launches .launch-card{display:grid;min-width:0;gap:.6rem;padding:clamp(.8rem,3vw,1.2rem);border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.8rem;background:color-mix(in srgb,currentColor 3%,transparent)}
.ss-launches .launch-muted{font-size:.88em;color:color-mix(in srgb,currentColor 78%,transparent)}
.ss-launches .launch-state{display:inline-block;border-radius:.4rem;padding:.2rem .45rem;background:color-mix(in srgb,currentColor 11%,transparent);font-size:.79em;font-weight:650}
.ss-launches .launch-footer{border-top:1px solid color-mix(in srgb,currentColor 22%,transparent);padding-top:.8rem}
.ss-launches .launch-preview{margin:0;white-space:pre-wrap}
.ss-launches .launch-preview-image{display:block;max-width:100%;width:100%;max-height:15rem;aspect-ratio:2.2/1;object-fit:cover;border-radius:.43rem}
.ss-launches .launch-problem{color:var(--ss-launch-error,#ed766a)}
`;

const reason = (error: unknown) => error instanceof Error ? error.message : "Could not load launches. Try again.";

export function ArticleLaunches({ client, insights, preferredHost, initialArticle, repliesHref, insightsHref, accent = "#79a9ff" }: {
  client: LaunchesClient;
  insights: InsightsClient;
  preferredHost?: string;
  initialArticle?: { did: string; rkey: string };
  repliesHref?: string;
  insightsHref?: string;
  accent?: string;
}) {
  const [sites, setSites] = useState<InsightSite[]>();
  const [did, setDid] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const requestedDid = initialArticle?.did;

  useEffect(() => {
    let active = true;
    setError("");
    void insights.sites().then(({ sites: eligible }) => {
      if (!active) return;
      setSites(eligible);
      setDid((eligible.find(site => site.did === requestedDid)
        ?? eligible.find(site => site.host === preferredHost) ?? eligible[0])?.did ?? "");
    }).catch(error => { if (active) setError(reason(error)); });
    return () => { active = false; };
  }, [insights, preferredHost, requestedDid, reload]);

  return <section className="ss-launches launch-stack" aria-label="Article launches" style={{ "--ss-launch-link": accent } as CSSProperties}>
    <style>{css}</style>
    <header>
      <h1>Article launches</h1>
      <p>Write announcements, schedule delivery, and see what happened on each network.</p>
    </header>
    {error ? <p role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p>
      : !sites ? <p role="status">Loading sites…</p>
      : !sites.length ? <p>No publishing sites are available to this account.</p>
      : did && <SiteLaunches
        key={did + (did === requestedDid ? initialArticle?.rkey : "")}
        initialRkey={did === requestedDid ? initialArticle?.rkey : undefined}
        sitePicker={<label className="launch-picker">Site
          <select value={did} onChange={event => setDid(event.target.value)}>
            {sites.map(site => <option key={site.did} value={site.did}>{site.host}</option>)}
          </select>
        </label>}
        {...{ did, client, insights, repliesHref, insightsHref }}
      />}
  </section>;
}

function SiteLaunches({ did, client, insights, repliesHref, insightsHref, initialRkey, sitePicker }: {
  did: string; sitePicker: ReactNode; initialRkey?: string; client: LaunchesClient; insights: InsightsClient; repliesHref?: string; insightsHref?: string;
}) {
  const [articles, setArticles] = useState<InsightArticle[]>();
  const [rkey, setRkey] = useState(initialRkey ?? "");
  const [next, setNext] = useState<string>();
  const [after, setAfter] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void insights.articles(did, after).then(page => {
      if (!active) return;
      setArticles(previous => after ? [...(previous ?? []), ...page.articles] : page.articles);
      setRkey(value => value || page.articles[0]?.rkey || "");
      setNext(page.next === after ? undefined : page.next);
    }).catch(error => { if (active) setError(reason(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [did, insights, after, reload]);

  return <div className="launch-stack">
    <div className="launch-columns">
      {sitePicker}
      <label className="launch-picker">Published article
        <select value={rkey} onChange={event => setRkey(event.target.value)} disabled={!articles?.length}>
          {rkey && !articles?.some(article => article.rkey === rkey) && <option value={rkey}>Selected article</option>}
          {!rkey && !articles?.length && <option value="">{loading ? "Loading articles…" : "No articles"}</option>}
          {articles?.map(article => <option key={article.rkey} value={article.rkey}>{article.title}</option>)}
        </select>
      </label>
    </div>
    {next && <div><button type="button" disabled={loading} onClick={() => setAfter(next)}>Load older articles</button></div>}
    {error && <p role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p>}
    {!rkey && !loading && !error && <p>Publish an article with “Plan the social launch separately” enabled to begin.</p>}
    {rkey && <LaunchPlan key={rkey} {...{ did, rkey, client, insights, repliesHref, insightsHref }} />}
  </div>;
}

function inputsFrom(channels: ArticleLaunch["channels"]): LaunchInputs {
  return {
    bluesky: { enabled: channels.bluesky.enabled, text: channels.bluesky.text },
    fediverse: { enabled: channels.fediverse.enabled, text: channels.fediverse.text },
  };
}

function LaunchPlan({ did, rkey, client, insights, repliesHref, insightsHref }: {
  did: string; rkey: string; client: LaunchesClient; insights: InsightsClient; repliesHref?: string; insightsHref?: string;
}) {
  const [plan, setPlan] = useState<ArticleLaunch>();
  const [inputs, setInputs] = useState<LaunchInputs>();
  const [card, setCard] = useState<ArticleDistribution["socialCard"]>();
  const [time, setTime] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    void client.load(did, rkey).then(result => {
      if (!active) return;
      setPlan(result);
      setInputs(inputsFrom(result.channels));
    }).catch(error => { if (active) setError(reason(error)); });
    void insights.distribution(did, rkey).then(result => {
      if (active) setCard(result.socialCard);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [client, insights, did, rkey, reload]);

  const running = !!plan?.run;
  const scheduledAt = plan?.run?.at;
  useEffect(() => {
    if (!running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      const untilDue = scheduledAt ? Date.parse(scheduledAt) - Date.now() : 0;
      timer = setTimeout(() => {
        if (untilDue > 0) {
          check();
          return;
        }
        void client.load(did, rkey).then(result => {
          if (active) setPlan(prior => !prior || result.version >= prior.version ? result : prior);
        }).catch(() => undefined).finally(() => { if (active) check(); });
      }, Math.min(2_000_000_000, Math.max(6_000, untilDue + 1_000)));
    }
    check();
    return () => { active = false; clearTimeout(timer); };
  }, [client, did, rkey, running, scheduledAt]);

  if (!plan || !inputs) {
    return error
      ? <p role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Refresh article</button></p>
      : <p role="status">Loading launch…</p>;
  }

  const url = plan.article.url;
  const eligible = launchPlatforms.filter(platform => plan.channels[platform].state === "draft" && inputs[platform].enabled);
  const saved = launchPlatforms.every(platform =>
    inputs[platform].enabled === plan.channels[platform].enabled && inputs[platform].text === plan.channels[platform].text);
  const overLimit = eligible.some(platform => !fitsLaunchLimit(inputs[platform].text, url, platform));
  const failed = launchPlatforms.some(platform => plan.channels[platform].state === "failed");
  const anyDraft = launchPlatforms.some(platform => plan.channels[platform].state === "draft");

  async function act(operation: Promise<ArticleLaunch>, feedback: string, clearTime = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await operation;
      setPlan(next);
      setInputs(inputsFrom(next.channels));
      setNotice(feedback);
      if (clearTime) setTime("");
    } catch (error) { setError(reason(error)); }
    finally { setBusy(false); }
  }

  async function copy(platform: LaunchPlatform) {
    const link = launchLink(url, platform);
    try {
      await navigator.clipboard.writeText(link);
      setNotice(`${platformNames[platform]} link copied.`);
    } catch {
      setNotice("Clipboard access is unavailable. Open the tracked link and copy it from the address bar.");
    }
  }

  const { article, run } = plan;
  return <div className="launch-stack">
    <section className="launch-card" aria-label="Article link preview">
      <p className="launch-muted">Article link preview</p>
      {card?.image && <img className="launch-preview-image" src={card.image} alt={card.imageAlt ?? ""} loading="lazy" />}
      <h2>{card?.title ?? article.title}</h2>
      {(card?.description || plan.description) && <p>{card?.description || plan.description}</p>}
      <a href={url} target="_blank" rel="noreferrer">Open public article ↗</a>
    </section>

    {plan.mode === "automatic" && <p>This article uses automatic syndication. For a future article, select “Plan the social launch separately” when writing the draft.</p>}

    {run && <section className="launch-card" aria-label="Launch progress">
      <h3>{run.at ? `Scheduled for ${new Date(run.at).toLocaleString()}` : "Launch in progress"}</h3>
      <p className="launch-muted">{run.platforms.map(platform => platformNames[platform]).join(" and ")} will start after the public article is verified.</p>
      <div className="launch-row">
        <button type="button" onClick={() => setReload(value => value + 1)}>Refresh status</button>
        {run.at && Date.parse(run.at) > Date.now() && <button type="button" disabled={busy}
          onClick={() => void act(client.cancel(did, rkey, plan.version), "Scheduled launch canceled.", true)}>Cancel launch</button>}
      </div>
    </section>}

    <div className="launch-columns">
      {launchPlatforms.map(platform => <ChannelCard key={platform} {...{
        platform, url, channel: plan.channels[platform], value: inputs[platform], busy: busy || running,
        running: run?.platforms.includes(platform), copy: () => void copy(platform),
        change: value => setInputs({ ...inputs, [platform]: value }),
      }} />)}
    </div>

    {error && <p role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>Refresh launch</button></p>}
    {notice && <p role="status">{notice}</p>}

    {plan.mode === "managed" && !running && <div className="launch-stack">
      {anyDraft && <div className="launch-row">
        <button type="button" disabled={busy || saved}
          onClick={() => void act(client.save(did, rkey, plan.version, inputs), "Announcements saved.")}>Save announcements</button>
        <button className="launch-primary" type="button" disabled={busy || !eligible.length || overLimit || !!time}
          onClick={() => void act(client.launch(did, rkey, plan.version, inputs), "Launch queued.")}>Launch now</button>
      </div>}
      {anyDraft && <form className="launch-row" onSubmit={event => {
        event.preventDefault();
        const at = new Date(time);
        if (Number.isNaN(at.getTime())) return;
        void act(client.launch(did, rkey, plan.version, inputs, at.toISOString()), "Launch scheduled.", true);
      }}>
        <label>Schedule time (local)
          <input type="datetime-local" value={time} onChange={event => setTime(event.target.value)} required />
        </label>
        <button type="submit" disabled={busy || !eligible.length || overLimit || !time}>Schedule launch</button>
      </form>}
      {failed && <div><button type="button" onClick={() => void act(client.retry(did, rkey, plan.version), "Retry queued.")} disabled={busy}>Retry failed</button></div>}
      {anyDraft && <p className="launch-muted">Launching sends a public announcement on each selected network. The article stays public if you cancel the launch.</p>}
    </div>}

    {(insightsHref || repliesHref) && <nav className="launch-row launch-footer" aria-label="Publishing workspace">
      {insightsHref && <a href={insightsHref}>Article insights</a>}
      {repliesHref && <a href={repliesHref}>Article replies</a>}
    </nav>}
  </div>;
}

function ChannelCard({ platform, url, channel, value, busy, running, copy, change }: {
  platform: LaunchPlatform;
  url: string;
  channel: LaunchChannel;
  value: LaunchInputs[LaunchPlatform];
  busy: boolean;
  running?: boolean;
  copy: () => void;
  change: (value: LaunchInputs[LaunchPlatform]) => void;
}) {
  const name = platformNames[platform];
  const count = launchLength(value.text, url, platform);
  const limit = launchLimit[platform];
  const fits = fitsLaunchLimit(value.text, url, platform);
  const editable = channel.state === "draft";
  return <section className="launch-card" aria-label={name}>
    <div className="launch-row">
      <h3>{name}</h3>
      <span className="launch-state">{running && (channel.state === "draft" || channel.state === "failed") ? "Pending" : stateNames[channel.state]}</span>
    </div>
    {editable && <>
      <div className="launch-row">
        <label><input type="checkbox" checked={value.enabled} disabled={busy}
          onChange={event => change({ ...value, enabled: event.target.checked })} />Include {name}</label>
      </div>
      <label className="launch-picker">{name} announcement
        <textarea value={value.text} disabled={busy || !value.enabled} maxLength={3000}
          placeholder="Optional intro to the article" onChange={event => change({ ...value, text: event.target.value })} />
      </label>
      <p className={fits ? "launch-muted" : "launch-problem"}>{count} / {limit} characters including link{!fits && count <= limit ? " · Too large for Bluesky" : ""}</p>
    </>}
    {!editable && channel.text && <p className="launch-preview">{channel.text}</p>}
    {channel.error && <p className="launch-problem">{channel.error}</p>}
    {channel.state === "queued" && <p className="launch-muted">The federation worker will attempt delivery to follower inboxes.</p>}
    {channel.state === "posted" && <p className="launch-muted">The post is in the publishing account’s repository. It may take time to appear in Bluesky.</p>}
    <div className="launch-row">
      {channel.url && <a href={channel.url} target="_blank" rel="noreferrer">{platform === "bluesky" ? "Open post ↗" : "Open ActivityPub object ↗"}</a>}
      <button type="button" onClick={copy}>Copy {name} link</button>
      <a href={launchLink(url, platform)} target="_blank" rel="noreferrer" className="launch-muted">Open tracked link ↗</a>
    </div>
  </section>;
}
