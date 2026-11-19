// CloudFront Function (runtime cloudfront-js-2.0), viewer-request.
// Mirrors infra/lib/lambdas/pds/longform-routing.ts decideEdge(). Keep in lockstep.
import cf from 'cloudfront'

var KVS = cf.kvs()
// Merged set — used ONLY by the apex/other-host branch so that path stays
// byte-identical to the original. Do NOT refactor the apex branch.
var RESERVED = {
  "xrpc":1,"oauth":1,".well-known":1,"mcp":1,"ap":1,"auth":1,"profile":1,"settings":1,
  "longform":1,"compose":1,"assets":1,"_expo":1,"static":1,"notifications":1,
  "search":1,"docs":1,"following":1,"index.html":1,"sitemap.xml":1,"rss.xml":1,"atom.xml":1,
  "robots.txt":1,"og-default.png":1,"manifest.json":1,"sw.js":1,"icon-512.png":1
}
// Split sets — used ONLY by the martzmakes.com tenant-host branch. Mirror
// infra/lib/lambdas/pds/longform-routing.ts (RESERVED_PREFIXES / RESERVED_FILES).
// PREFIXES are shared platform routes that must resolve at the apex even under
// the tenant host → passthrough UNCHANGED. FILES that T4/T5 actually produce
// per-tenant must be served from the tenant prefix instead of the apex objects.
var RESERVED_PREFIXES = {
  "xrpc":1,"oauth":1,".well-known":1,"mcp":1,"ap":1,"auth":1,"profile":1,"settings":1,
  "longform":1,"compose":1,"assets":1,"_expo":1,"static":1,"notifications":1,
  "search":1,"docs":1,"following":1
}
var RESERVED_FILES = {
  "index.html":1,"sitemap.xml":1,"rss.xml":1,"atom.xml":1,"robots.txt":1,"og-default.png":1,
  "manifest.json":1,"sw.js":1,"icon-512.png":1
}

// ── Task 14: SPA shell routing + real 404s ─────────────────────────────────
// This function only runs on each distribution's DEFAULT (S3) behavior; the
// xrpc/oauth/mcp/auth/ap/.well-known behaviors go to the API origin and never
// reach it. The distributions no longer carry 403/404 -> /index.html custom
// error responses (they masked every API 404/403, e.g. webfinger and /ap/*
// misses), so anything that must serve the SPA has to be rewritten to a shell
// object HERE, and anything that misses S3 gets a real 404 from the
// origin-response Lambda@Edge (lib/not-found-edge.js).
//
// Shell objects are produced at deploy time by scripts/finalize-dist.mjs:
//   /index.html                          apex SPA shell for routes (no canonical)
//   /_shell/home.<host>.html             home shell with per-host SEO metadata
//   /_shell/app.martzmakes.com.html      martzmakes route shell (no canonical)
//   /_shell/robots.<host>.txt            text/plain robots with a Sitemap line
//   /_shell/manifest.martzmakes.com.json martzmakes web app manifest
// Client-side routes (mirror of parsePath() in app/App.tsx). 'longform' and the
// legacy /post/<actor>/<rkey> form are included so old links keep working.
var SPA_ROUTES = {
  "profile":1,"settings":1,"longform":1,"compose":1,"notifications":1,
  "search":1,"docs":1,"following":1
}
// Slugs are [a-z0-9-] (safeSlug can emit a leading '-'). Anything else that is
// not a reserved route is junk (/.env, /wp-login.php, /a/b) and 404s here.
var SLUG_RE = /^[a-z0-9-]+$/
var NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Page not found</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#07090C;color:#EEF1F6;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}' +
  'main{max-width:30rem;padding:2rem}p.code{color:#8A94A6;margin:0;font-size:14px;letter-spacing:.08em}' +
  'h1{font-size:28px;margin:.25rem 0 1rem}a{color:#7DB0FF}a:focus-visible{outline:2px solid #7DB0FF;outline-offset:3px}</style>' +
  '</head><body><main><p class="code">404</p><h1>That page does not exist</h1>' +
  '<p>The link may be old, or the post may not be published yet. Try the <a href="/">home page</a> or <a href="/search">search</a>.</p>' +
  '</main></body></html>'

function notFound() {
  return { statusCode: 404, statusDescription: 'Not Found',
    headers: { 'content-type': { value: 'text/html; charset=utf-8' },
      'cache-control': { value: 'public, max-age=10' } },
    body: NOT_FOUND_HTML }
}
// segs = path segments with leading/trailing slashes trimmed.
function isShellRoute(segs) {
  var s0 = segs[0]
  if (SPA_ROUTES[s0] === 1) return true
  if (s0 === 'post' && segs.length === 3) return true
  if (s0 === 'auth' && segs.length === 2 && segs[1] === 'complete') return true
  return false
}

async function handler(event) {
  var req = event.request
  // Host-keyed routing (Spec #5b / T6). Header keys are lowercase; value casing
  // is not guaranteed — normalize. Missing host → fall through to apex path.
  var host = (req.headers && req.headers.host && req.headers.host.value)
    ? req.headers.host.value.toLowerCase() : ''

  // www.martzmakes.com → 301 to the apex martzmakes host, BEFORE any rewrite,
  // preserving the original request URI.
  if (host === 'www.martzmakes.com') {
    // NOTE: CloudFront Functions `request.uri` excludes the querystring, so any
    // `?…` is intentionally dropped on this canonical www→apex 301. Documented,
    // acceptable — not a bug.
    return { statusCode: 301, statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://martzmakes.com' + req.uri } } }
  }

  // martzmakes.com → SAME slug/reserved/asset/favicon logic, but rewrites are
  // served from the tenant S3 prefix. Reserved/asset/favicon pass through
  // UNCHANGED (no prefix) so platform routes still work under this host. The
  // KVS is per-tenant (keyed by the renderer's tenant scope elsewhere), so its
  // 301/410 values are used as-is — no prefixing applied to KVS results.
  if (host === 'martzmakes.com') {
    var muri = req.uri
    var mseg = muri.replace(/^\/+/, '').split('/')[0]
    // '' (root) → tenant index.
    if (mseg === '') {
      // Spec #5c: the SPA bundle serves at '/'. Task 14: serve the martzmakes
      // home shell (host-specific title/description/og/canonical/alternates).
      req.uri = '/_shell/home.martzmakes.com.html'
      return req
    }
    if (isShellRoute(muri.replace(/^\/+|\/+$/g, '').split('/'))) {
      req.uri = '/_shell/app.martzmakes.com.html'
      return req
    }
    // Shared platform routes (RESERVED_PREFIXES) + favicon* → passthrough
    // UNCHANGED so they keep resolving at the apex under the tenant host.
    if (RESERVED_PREFIXES[mseg] === 1 || mseg.indexOf('favicon') === 0) return req
    if (RESERVED_FILES[mseg] === 1) {
      // index.html / sitemap.xml / rss.xml / atom.xml have a per-tenant
      // producer (T4/T5) → serve from the tenant prefix so the tenant
      // artifacts are reachable instead of the apex objects.
      if (mseg === 'index.html' || mseg === 'sitemap.xml' ||
          mseg === 'rss.xml' || mseg === 'atom.xml') {
        req.uri = '/t/martzmakes.com/' + mseg
        return req
      }
      // Task 14: per-host robots.txt and web app manifest are produced at
      // deploy time under /_shell/ (scripts/finalize-dist.mjs).
      if (mseg === 'robots.txt') { req.uri = '/_shell/robots.martzmakes.com.txt'; return req }
      if (mseg === 'manifest.json') { req.uri = '/_shell/manifest.martzmakes.com.json'; return req }
      // sw.js / og-default.png / icon-512.png have NO tenant producer →
      // pass through to the shared object.
      return req
    }
    var mslug = muri.replace(/^\/+/, '').replace(/\/+$/, '')
    if (mslug === '') { req.uri = '/t/martzmakes.com/index.html'; return req }
    var mval
    try { mval = await KVS.get(mslug) } catch (e) { mval = undefined }
    if (mval === '410') {
      return { statusCode: 410, statusDescription: 'Gone',
        headers: { 'content-type': { value: 'text/html' } },
        body: '<!doctype html><title>410 Gone</title><h1>410 — this article was removed</h1>' }
    }
    if (mval && mval.indexOf('301 ') === 0) {
      return { statusCode: 301, statusDescription: 'Moved Permanently',
        headers: { location: { value: mval.substring(4) } } }
    }
    if (!SLUG_RE.test(mslug)) return notFound()
    req.uri = '/t/martzmakes.com/' + mslug + '/index.html'
    return req
  }

  // Apex (serverless.social) or any other/missing host — ORIGINAL logic
  // verbatim, byte-for-byte unchanged.
  var uri = req.uri
  // Task 14 (additive): SPA shell routes, home shell and robots for the apex.
  // Everything below the "ORIGINAL logic" marker is unchanged except the
  // junk-slug 404 guard immediately before the slug rewrite.
  var asegs = uri.replace(/^\/+|\/+$/g, '').split('/')
  if (asegs[0] === '') { req.uri = '/_shell/home.serverless.social.html'; return req }
  if (isShellRoute(asegs)) { req.uri = '/index.html'; return req }
  if (asegs.length === 1 && asegs[0] === 'robots.txt') { req.uri = '/_shell/robots.serverless.social.txt'; return req }
  // ORIGINAL logic:
  var seg = uri.replace(/^\/+/, '').split('/')[0]
  if (seg === '' || RESERVED[seg] === 1 || seg.indexOf('favicon') === 0) return req
  var slug = uri.replace(/^\/+/, '').replace(/\/+$/, '')
  if (slug === '') return req
  var val
  try { val = await KVS.get(slug) } catch (e) { val = undefined }
  if (val === '410') {
    return { statusCode: 410, statusDescription: 'Gone',
      headers: { 'content-type': { value: 'text/html' } },
      body: '<!doctype html><title>410 Gone</title><h1>410 — this article was removed</h1>' }
  }
  if (val && val.indexOf('301 ') === 0) {
    return { statusCode: 301, statusDescription: 'Moved Permanently',
      headers: { location: { value: val.substring(4) } } }
  }
  if (!SLUG_RE.test(slug)) return notFound()
  // Fallthrough = treat as a longform slug. ANY new top-level SPA route MUST be
  // added to RESERVED above (and to longform-routing.ts RESERVED_PREFIXES, kept
  // in lockstep) or it will be rewritten here as a slug lookup and soft-404.
  req.uri = '/' + slug + '/index.html'
  return req
}
