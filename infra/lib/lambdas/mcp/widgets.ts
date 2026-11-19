// MCP Apps widget definitions.
//
// Widgets are self-contained HTML documents Claude iframes inline with
// tool results. They receive `structuredContent` from the paired tool
// call via a postMessage handshake (the `WIDGET_BOOTSTRAP_JS` below
// implements the spec-mandated dance). Each widget defines a top-level
// `render(output)` function that mounts the data into the DOM.
//
// To add a widget:
//   1. Write a new HTML literal below.
//   2. Register it in UI_RESOURCES.
//   3. On the paired tool definition in server.ts, set
//      `_meta: widgetUiMeta("ui://<slug>/<name>")`.
//
// Widgets are served two ways:
//   - resources/read returns them inline as `text/html;profile=mcp-app`
//   - GET /mcp/ui/<name> serves the same HTML directly so Claude can iframe it
//
// Spec: https://modelcontextprotocol.io/specification (MCP Apps extension)

const PROJECT_SLUG = process.env.PROJECT_SLUG!;
const DOMAIN = process.env.DOMAIN!;
const WIDGET_DOMAIN =
  process.env.MCP_WIDGET_DOMAIN ||
  "<COMPUTE_AFTER_FIRST_DEPLOY>.claudemcpcontent.com";

export interface UIResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  content: string;
  meta: {
    ui: {
      domain: string;
      permissions: Record<string, unknown>;
      csp: { connectDomains: string[]; resourceDomains: string[] };
    };
  };
}

const DEFAULT_META: UIResource["meta"] = {
  ui: {
    domain: WIDGET_DOMAIN,
    permissions: {},
    csp: {
      connectDomains: [DOMAIN, WIDGET_DOMAIN],
      resourceDomains: [],
    },
  },
};

// ---------------------------------------------------------------------------
// Widget bootstrap — postMessage handshake with the host (Claude/etc).
// Lifted near-verbatim from the MCP Apps spec; implements:
//   1) Widget -> host:  ui/initialize request
//   2) Host   -> widget: result (protocolVersion, hostInfo, hostContext)
//   3) Widget -> host:  ui/notifications/initialized notification
//   4) Host   -> widget: ui/notifications/tool-result -> calls render()
//   5) Widget -> host:  ui/notifications/size-changed notifications
//   6) Host   -> widget: ui/notifications/host-context-changed -> re-render
// Plus a window.openai shim and legacy postMessage fallback for older hosts.
// Each widget MUST define a top-level render(output) function.
// ---------------------------------------------------------------------------
const WIDGET_BOOTSTRAP_JS = `(function(){
  var pending = new Map();
  var nextId = 1;

  function sendRequest(method, params) {
    return new Promise(function(resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      setTimeout(function(){ if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 15000);
      try { window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*'); } catch (e) { pending.delete(id); reject(e); }
    });
  }

  function sendNotification(method, params) {
    try { window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*'); } catch (e) {}
  }

  function extractToolOutput(params) {
    if (!params) return null;
    if (params.structuredContent != null) return params.structuredContent;
    if (Array.isArray(params.content)) {
      var t = params.content.find(function(c){ return c && c.type === 'text' && typeof c.text === 'string'; });
      if (t && t.text) { try { return JSON.parse(t.text); } catch(e) {} }
    }
    return null;
  }

  function onToolResult(params) {
    var output = extractToolOutput(params);
    if (output == null) return;
    window.__mcpAppState = Object.assign({}, window.__mcpAppState || {}, { toolOutput: output });
    window.dispatchEvent(new Event('mcp:state-changed'));
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: window.__mcpAppState } }));
    try { render(output); } catch (e) { console.error('[MCP Apps] render failed', e); }
    notifyHeight();
  }

  var resizeTimer = null;
  function notifyHeight() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      try {
        var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        var w = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
        sendNotification('ui/notifications/size-changed', { width: w, height: h });
      } catch(e) {}
    }, 50);
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && pending.has(msg.id)) {
      var p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') {
      onToolResult(msg.params || {});
    } else if (msg.method === 'ui/notifications/host-context-changed') {
      var cached = window.__mcpAppState && window.__mcpAppState.toolOutput;
      if (cached) { try { render(cached); notifyHeight(); } catch(e){} }
    }
  });

  if (!window.openai) {
    window.openai = {
      get toolOutput() { return (window.__mcpAppState && window.__mcpAppState.toolOutput) || null; },
      notifyIntrinsicHeight: function(h) {
        sendNotification('ui/notifications/size-changed', { height: h });
      }
    };
  }

  sendRequest('ui/initialize', {
    appInfo: { name: 'app-widget', version: '1.0.0' },
    appCapabilities: { tools: { listChanged: false } },
    protocolVersion: '2025-11-25'
  }).then(function(result){
    window.__mcpAppState = Object.assign({}, window.__mcpAppState || {}, { hostContext: result && result.hostContext });
    sendNotification('ui/notifications/initialized', {});
    notifyHeight();
    var cached = window.__mcpAppState && window.__mcpAppState.toolOutput;
    if (cached) { try { render(cached); } catch(e){} }
  }).catch(function(err){
    console.warn('[MCP Apps] ui/initialize failed - falling back to legacy postMessage', err);
  });

  // Legacy postMessage fallback for hosts that pre-MCP-Apps push raw data.
  window.addEventListener('message', function(event) {
    var data = event.data || {};
    if (data && data.jsonrpc) return;
    if (data.type === 'tool-result' && data.structuredContent) {
      onToolResult({ structuredContent: data.structuredContent });
    } else if (data && (data.structuredContent || data.toolOutput)) {
      onToolResult({ structuredContent: data.structuredContent || data.toolOutput });
    }
  });

  window.addEventListener('resize', notifyHeight);
})();`;

// ---------------------------------------------------------------------------
// Widget: user-card
// Pairs with the `whoami` tool. Renders the signed-in user's email + entitlements.
// Replace with widgets that match your domain tools.
// ---------------------------------------------------------------------------
const USER_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>User profile</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'General Sans', -apple-system, Segoe UI, Roboto, sans-serif;
    background: transparent;
    color: #EEF1F6;
    padding: 16px;
    letter-spacing: -0.01em;
  }
  .card {
    background: #11151C;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 8px;
    padding: 20px;
    max-width: 420px;
  }
  .eyebrow {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: #8892A0;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .email {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 16px;
    color: #EEF1F6;
    word-break: break-all;
    margin-bottom: 16px;
  }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid rgba(255,255,255,0.06); font-size: 13px; }
  .row .k { color: #8892A0; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
  .row .v { color: #EEF1F6; }
  .empty { color: #5D6674; font-style: italic; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">PROFILE</div>
    <div class="email" id="email">—</div>
    <div class="row"><span class="k">Owned</span><span class="v" id="owned">—</span></div>
    <div class="row"><span class="k">Joined</span><span class="v" id="created">—</span></div>
    <div class="row"><span class="k">Last login</span><span class="v" id="login">—</span></div>
  </div>
<script>
function render(output) {
  if (!output) return;
  document.getElementById('email').textContent = output.email || '—';
  var ents = (output.ownedEntitlements && output.ownedEntitlements.length)
    ? output.ownedEntitlements.join(', ')
    : 'None';
  document.getElementById('owned').textContent = ents;
  function fmt(ts) { return ts ? new Date(ts).toLocaleDateString() : '—'; }
  document.getElementById('created').textContent = fmt(output.createdAt);
  document.getElementById('login').textContent = fmt(output.lastLoginAt);
}
${WIDGET_BOOTSTRAP_JS}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const UI_RESOURCES: Record<string, UIResource> = {
  [`ui://${PROJECT_SLUG}/user-card`]: {
    uri: `ui://${PROJECT_SLUG}/user-card`,
    name: "user-card",
    description: "Profile card showing email, entitlements, and timestamps.",
    mimeType: "text/html;profile=mcp-app",
    content: USER_CARD_HTML,
    meta: DEFAULT_META,
  },
};

export function listResources() {
  return Object.values(UI_RESOURCES).map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
    _meta: r.meta,
  }));
}

export function readResource(uri: string) {
  const r = UI_RESOURCES[uri];
  if (!r) return null;
  return {
    contents: [
      {
        uri: r.uri,
        mimeType: r.mimeType,
        text: r.content,
        _meta: r.meta,
      },
    ],
  };
}
