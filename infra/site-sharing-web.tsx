import { useEffect, useState, type CSSProperties } from "react";
import type { InsightsClient, SharingDirections, SiteSharing } from "./insights";

const body: CSSProperties = { color: "inherit", font: "14px/1.55 system-ui, sans-serif", overflowWrap: "anywhere" };
const field: CSSProperties = { minWidth: 0, border: "1px solid #526178", borderRadius: 10, margin: ".85rem 0 0", padding: ".8rem 1rem" };
const label: CSSProperties = { display: "flex", alignItems: "baseline", gap: ".45rem", paddingBlock: ".25rem" };
const button: CSSProperties = { font: "inherit", minHeight: "2.55rem", marginTop: ".6rem" };

export function SiteSharingSettings({ client }: { client: InsightsClient }) {
  const [settings, setSettings] = useState<SiteSharing>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void client.sharing().then(value => { if (active) setSettings(value); })
      .catch(() => { if (active) setError("Couldn’t load this site’s sharing settings."); });
    return () => { active = false; };
  }, [client, retry]);

  if (settings && !settings.peers.length) return null;
  return (
    <section aria-label="Cross-site sharing" style={body}>
      <h2 style={{ fontSize: "1.15rem", marginBlock: "0 .4rem" }}>Cross-site sharing</h2>
      {!settings && (error ? (
        <p role="alert">{error} <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>
      ) : <p role="status">Loading sharing settings…</p>)}
      {settings && <>
        <p style={{ margin: 0 }}>Choose which sites can work with {settings.host}’s articles, replies, drafts, and analytics. Both sites must permit sharing in a direction.</p>
        <p style={{ margin: ".35rem 0 0" }}>Public posts and copies already made are available at their original destinations.</p>
        {settings.peers.map(peer => <SharingPeer key={peer.host} client={client} peer={peer} />)}
      </>}
    </section>
  );
}

function SharingPeer({ client, peer }: { client: InsightsClient; peer: SiteSharing["peers"][number] }) {
  const [saved, setSaved] = useState<SharingDirections>(peer);
  const [value, setValue] = useState<SharingDirections>(peer);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const dirty = value.outgoing !== saved.outgoing || value.incoming !== saved.incoming;

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await client.updateSharing(peer.host, value);
      setSaved(result);
      setValue(result);
      setStatus("Sharing settings saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn’t save sharing settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset style={field} disabled={busy}>
      <legend>{peer.host}</legend>
      <label style={label}><input type="checkbox" checked={value.outgoing}
        onChange={event => { setStatus(""); setValue({ ...value, outgoing: event.target.checked }); }} />
        Share this site’s content with {peer.host}
      </label>
      <label style={label}><input type="checkbox" checked={value.incoming}
        onChange={event => { setStatus(""); setValue({ ...value, incoming: event.target.checked }); }} />
        Show content from {peer.host} in this workspace
      </label>
      <button style={button} type="button" disabled={!dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save sharing settings"}</button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
