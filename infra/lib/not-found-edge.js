// Lambda@Edge (nodejs20.x), ORIGIN-RESPONSE, attached to the DEFAULT (S3)
// behavior of both site distributions only.
//
// Why: the distributions used to map every origin 403/404 to /index.html with a
// 200 (SPA fallback). That masked real API errors (webfinger and /ap/* misses,
// 403s) and gave unknown slugs and /.env a 200 home page. Those custom error
// responses are gone; client-side routes are now rewritten to the shell by
// longform-edge.js, so an S3 miss really is "no such page". With OAC and no
// s3:ListBucket, S3 reports a missing key as 403, so both 403 and 404 mean
// "not found" here.
//
// The generated 404 is cached for 10 seconds. A just-published post is rendered
// to S3 some seconds after the record is written, and a viewer who probed the URL
// first must not stay stuck on 404.
//
// Keep NOT_FOUND_HTML in sync with the copy in longform-edge.js.
'use strict'

const NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Page not found</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#07090C;color:#EEF1F6;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}' +
  'main{max-width:30rem;padding:2rem}p.code{color:#8A94A6;margin:0;font-size:14px;letter-spacing:.08em}' +
  'h1{font-size:28px;margin:.25rem 0 1rem}a{color:#7DB0FF}a:focus-visible{outline:2px solid #7DB0FF;outline-offset:3px}</style>' +
  '</head><body><main><p class="code">404</p><h1>That page does not exist</h1>' +
  '<p>The link may be old, or the post may not be published yet. Try the <a href="/">home page</a> or <a href="/search">search</a>.</p>' +
  '</main></body></html>'

exports.NOT_FOUND_HTML = NOT_FOUND_HTML

// Mutate the origin response in place. Returning a fresh object drops the
// read-only headers S3 set (Transfer-Encoding, Via, ...), and CloudFront then
// fails the whole response with a 502 "LambdaValidationError" (seen live on
// 2026-10-31). Content-Length is dropped so CloudFront recomputes it for the
// new body.
exports.handler = async (event) => {
  const response = event.Records[0].cf.response
  const status = parseInt(response.status, 10)
  if (status !== 403 && status !== 404) return response
  const h = response.headers || (response.headers = {})
  delete h['content-length']
  delete h['content-encoding']
  h['content-type'] = [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }]
  h['cache-control'] = [{ key: 'Cache-Control', value: 'public, max-age=10' }]
  response.status = '404'
  response.statusDescription = 'Not Found'
  response.body = NOT_FOUND_HTML
  response.bodyEncoding = 'text'
  return response
}
