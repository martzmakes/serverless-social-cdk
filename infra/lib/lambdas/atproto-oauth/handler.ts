import { randomBytes, createHash } from 'node:crypto'
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { asMetadata, protectedResourceMetadata } from './metadata'
import { OAuthStore } from './store'
import { loadClientMetadata } from './client-meta'
import { verifyDpopProof } from './dpop'
import { resolveTenant, resolveTenantByHost, apexTenant, type Tenant, type TenantStore } from '../pds/tenant'
import { makeAccessFor } from '../pds/session'
import { HANDLE } from '../pds/lexicons'

const rid = (p: string) => p + randomBytes(24).toString('base64url')
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Same host-detection pattern as pds/handler.ts's viewerHost(): CloudFront
// currently rewrites the Host header before it reaches this Lambda too, so a
// dedicated `x-pds-viewer-host` header (once infra wires a per-distribution
// origin customHeader — see that file's viewerHost() doc comment) takes
// priority over the raw `host`/`Host` header. Until that infra change ships,
// every production request resolves via `host`, which is the shared
// execute-api domain — resolveTenantByHost() safely falls back to apex, i.e.
// this is a no-op in production today and activates the moment infra adds it.
function viewerHost(headers?: Record<string, string>): string | undefined {
  return headers?.['x-pds-viewer-host'] || headers?.host || headers?.Host
}

export interface OAuthDeps {
  issuer: string
  store: any
  resolveTenantByHandle: (h: string) => Promise<{ did: string; handle: string; email: string } | null>
  loadClient: (clientId: string) => Promise<{ client_id: string; redirect_uris: string[]; dpop_bound_access_tokens: boolean }>
  sendMagicLink: (a: { email: string; oauthCode: string }) => Promise<void>
  verifyDpop: (proof: string, c: { htm: string; htu: string }) => Promise<{ jkt: string }>
  resolveTenantByDid: (did: string) => Promise<import('../pds/tenant').Tenant | null>
  makeAccess: (t: import('../pds/tenant').Tenant, jkt: string) => Promise<string>
  // Host-scoped tenant lookup for the `/.well-known/oauth-*` discovery
  // documents — mirrors pds/tenant.ts's resolveTenantByHost() exactly
  // (never null; unrecognized/apex/missing host → apexTenant()).
  resolveTenantByHost: (host: string | undefined) => Promise<import('../pds/tenant').Tenant>
}
export type OAuthResult = { status: number; body: string; contentType?: string; headers?: Record<string, string> }
const json = (status: number, o: unknown): OAuthResult => ({ status, body: JSON.stringify(o), contentType: 'application/json' })
const html = (status: number, h: string): OAuthResult => ({ status, body: h, contentType: 'text/html; charset=utf-8' })

export async function routeOAuth(method: string, path: string, params: Record<string, any>, d: OAuthDeps, headers?: Record<string, string>): Promise<OAuthResult> {
  if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    const tenant = await d.resolveTenantByHost(viewerHost(headers))
    // apex resolves to `d.issuer` verbatim (not `https://${HANDLE}`) so an
    // apex/no-Host request is byte-identical to pre-host-awareness output
    // even if ISSUER and HANDLE were ever to diverge in scheme/casing.
    const issuer = tenant.handle === HANDLE ? d.issuer : `https://${tenant.handle}`
    return json(200, asMetadata(issuer))
  }
  if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
    const tenant = await d.resolveTenantByHost(viewerHost(headers))
    const issuer = tenant.handle === HANDLE ? d.issuer : `https://${tenant.handle}`
    return json(200, protectedResourceMetadata(issuer))
  }

  if (method === 'POST' && path === '/oauth/atproto/par') {
    for (const k of ['client_id', 'redirect_uri', 'code_challenge', 'response_type', 'scope']) {
      if (!params[k]) return json(400, { error: 'invalid_request', error_description: `missing ${k}` })
    }
    if (params.code_challenge_method !== 'S256') return json(400, { error: 'invalid_request', error_description: 'PKCE S256 required' })
    if (params.response_type !== 'code') return json(400, { error: 'unsupported_response_type' })
    const meta = await d.loadClient(params.client_id)
    await d.store.cacheClient(params.client_id, meta)
    if (!meta.redirect_uris.includes(params.redirect_uri)) return json(400, { error: 'invalid_request', error_description: 'redirect_uri not registered' })
    const uri = rid('urn:ietf:params:oauth:request_uri:')
    await d.store.putPar(uri, { ...params }, 120)
    return { status: 201, body: JSON.stringify({ request_uri: uri, expires_in: 120 }), contentType: 'application/json' }
  }

  if (method === 'GET' && path === '/oauth/atproto/authorize') {
    if (!params.request_uri) return json(400, { error: 'invalid_request', error_description: 'PAR required' })
    const req = await d.store.takePar(params.request_uri)
    if (!req) return json(400, { error: 'invalid_request', error_description: 'unknown/expired request_uri' })
    const hint = req.login_hint || params.login_hint
    if (!hint) {
      // Re-store under the same request_uri so the handle-entry form's follow-up
      // GET can re-take it. The URI is single-use per take; whoever holds it can
      // supply login_hint (standard PAR property — the magic-link email to the
      // resolved tenant's address is the actual authentication factor).
      await d.store.putPar(params.request_uri, req, 120)
      return html(200, loginHintForm(esc(params.request_uri)))
    }
    const tenant = await d.resolveTenantByHandle(hint)
    if (!tenant) return json(400, { error: 'invalid_request', error_description: 'unknown account' })
    const code = rid('')
    await d.store.putAuthRequest(code, {
      clientId: req.client_id, redirectUri: req.redirect_uri, codeChallenge: req.code_challenge,
      scope: req.scope, state: req.state, did: tenant.did, expiresAt: Date.now() + 15 * 60 * 1000,
    })
    await d.sendMagicLink({ email: tenant.email, oauthCode: code })
    return html(200, checkEmailPage(esc(tenant.handle)))
  }
  if (method === 'POST' && path === '/oauth/atproto/token') {
    const dpop = params.__dpop as string | undefined
    if (!dpop) return {
      status: 400, contentType: 'application/json',
      // Nonce challenge per RFC 9449 §7. Real nonce *validation* (seenJti/replay)
      // is threaded through verifyDpop by the Task 6 APIGW adapter.
      headers: { 'DPoP-Nonce': rid(''), 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' },
      body: JSON.stringify({ error: 'use_dpop_nonce', error_description: 'DPoP proof required' }),
    }
    if (params.grant_type === 'authorization_code') {
      const { jkt } = await d.verifyDpop(dpop, { htm: 'POST', htu: `${d.issuer}/oauth/atproto/token` })
      const ar = await d.store.consumeAuthRequest(params.code)
      if (!ar || !ar.approved || !ar.did || ar.expiresAt <= Date.now()) return json(400, { error: 'invalid_grant' })
      if (s256(params.code_verifier || '') !== ar.codeChallenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' })
      const tenant = await d.resolveTenantByDid(ar.did)
      if (!tenant) return json(400, { error: 'invalid_grant' })
      const access = await d.makeAccess(tenant, jkt)
      const refresh = rid('rt_')
      await d.store.putRefresh(refresh, { did: ar.did, jkt, clientId: ar.clientId, scope: ar.scope ?? 'atproto' })
      return json(200, { access_token: access, token_type: 'DPoP', expires_in: 7200, refresh_token: refresh, scope: ar.scope })
    }
    if (params.grant_type === 'refresh_token') {
      const { jkt } = await d.verifyDpop(dpop, { htm: 'POST', htu: `${d.issuer}/oauth/atproto/token` })
      const row = await d.store.takeRefresh(params.refresh_token)
      if (!row) return json(400, { error: 'invalid_grant' })
      if (jkt !== row.jkt) return json(400, { error: 'invalid_grant', error_description: 'jkt mismatch' })
      const tenant = await d.resolveTenantByDid(row.did)
      if (!tenant) return json(400, { error: 'invalid_grant' })
      const access = await d.makeAccess(tenant, jkt)
      const refresh = rid('rt_')
      await d.store.putRefresh(refresh, { did: row.did, jkt, clientId: row.clientId, scope: row.scope ?? 'atproto' })
      return json(200, { access_token: access, token_type: 'DPoP', expires_in: 7200, refresh_token: refresh, scope: row.scope ?? 'atproto' })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }
  return json(404, { error: 'not_found' })
}

function checkEmailPage(handle: string) {
  return `<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#07090C;color:#EEF1F6;text-align:center;padding:48px"><h1>Check your email</h1><p>We sent a sign-in link to the address on file for <b>${handle}</b>.</p></body>`
}
function loginHintForm(requestUri: string) {
  return `<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#07090C;color:#EEF1F6;text-align:center;padding:48px"><h1>Sign in</h1><form method="GET" action="/oauth/atproto/authorize"><input type="hidden" name="request_uri" value="${requestUri}"><input name="login_hint" placeholder="you.serverless.social" style="padding:10px"><button>Continue</button></form></body>`
}

// ===========================================================================
// APIGW HTTP API v2 entrypoint — assembles real OAuthDeps and dispatches to
// routeOAuth(). Mirrors the structure of pds/handler.ts & oauth/handler.ts.
// ===========================================================================

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,dpop',
  'access-control-expose-headers': 'location,dpop-nonce,www-authenticate',
}

// Cached SSM JWT secret — same pattern as pds/handler.ts.
const ssm = new SSMClient({})
let cachedJwtSecret: Uint8Array | null = null
async function getJwtSecret(): Promise<Uint8Array> {
  if (cachedJwtSecret) return cachedJwtSecret
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env.JWT_SECRET_PARAM!, WithDecryption: true }),
  )
  const value = res.Parameter?.Value
  if (!value) throw new Error('JWT secret SSM param is empty')
  cachedJwtSecret = new TextEncoder().encode(value)
  return cachedJwtSecret
}

const ses = new SESv2Client({})

function makeTenantStore(doc: any, table: string): TenantStore {
  return {
    async byDid(did: string) {
      const res = await doc.send(new GetCommand({ TableName: table, Key: { did } }))
      return res.Item ?? null
    },
    async byHandle(handle: string) {
      const res = await doc.send(new QueryCommand({
        TableName: table, IndexName: 'byHandle',
        KeyConditionExpression: 'handle = :h',
        ExpressionAttributeValues: { ':h': handle },
        Limit: 1,
      }))
      return res.Items?.[0] ?? null
    },
    async listActive() {
      const res = await doc.send(new ScanCommand({
        TableName: table,
        FilterExpression: '#s = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':a': 'active' },
      }))
      return (res.Items ?? []) as Array<{ did: string }>
    },
  }
}

async function sendMagicLinkEmailRaw(to: string, verifyUrl: string): Promise<void> {
  // Replicates auth/lib/email.ts minimally (do NOT refactor auth/request.ts).
  const from = process.env.SES_FROM_ADDRESS!
  const textBody = [
    'Tap the link below to sign in:',
    '',
    verifyUrl,
    '',
    'This link expires in 15 minutes and can only be used once.',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n')
  const htmlBody = `<div style="font-family:'General Sans',-apple-system,Segoe UI,Roboto,sans-serif;background:#07090C;color:#EEF1F6;padding:32px 24px;border-radius:10px;max-width:480px;margin:0 auto;border:1px solid rgba(255,255,255,0.1);"><div style="font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.08em;color:#8892A0;text-transform:uppercase;margin:0 0 12px;">SIGN IN</div><h1 style="margin:0 0 12px;font-size:24px;font-weight:600;">Sign in</h1><p style="line-height:1.5;margin:0 0 24px;color:#B8C0CC;font-size:15px;">Tap the button below to sign in. This link expires in 15 minutes and can only be used once.</p><p style="margin:0 0 24px;"><a href="${verifyUrl}" style="display:inline-block;background:#3B82FF;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px;">Sign in</a></p><p style="font-size:12px;color:#8892A0;line-height:1.5;margin:0;">Or paste this URL:<br><span style="word-break:break-all;">${verifyUrl}</span></p></div>`
  await ses.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: 'Your sign-in link', Charset: 'UTF-8' },
      Body: {
        Text: { Data: textBody, Charset: 'UTF-8' },
        Html: { Data: htmlBody, Charset: 'UTF-8' },
      },
    } },
  }))
}

export function buildDeps(): OAuthDeps {
  const issuer = process.env.ISSUER || 'https://serverless.social'
  const domain = process.env.DOMAIN || 'serverless.social'
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  const store = new OAuthStore(doc, process.env.OAUTH_TABLE!)
  const tenantsTable = process.env.TENANTS_TABLE!
  const tenantStore = makeTenantStore(doc, tenantsTable)
  const magicTable = process.env.MAGIC_LINK_TOKENS_TABLE!

  return {
    issuer,
    store,
    async resolveTenantByHandle(h: string) {
      if (h === HANDLE) {
        const t = apexTenant()
        const email = process.env.ADMIN_EMAIL
        // Apex needs an admin address to send the magic link to.
        if (!email) return null
        return { did: t.did, handle: t.handle, email }
      }
      const row = await tenantStore.byHandle(h)
      if (!row || row.status !== 'active') return null
      // Task 7 backfills `email` onto the tenant row. Until then a row without
      // an email yields a clean "unknown account" 400 from authorize rather
      // than a crash mid-dependency.
      if (!row.email) return null
      return { did: row.did, handle: row.handle, email: row.email }
    },
    async resolveTenantByDid(did: string): Promise<Tenant | null> {
      return resolveTenant({ did }, tenantStore)
    },
    async resolveTenantByHost(host: string | undefined): Promise<Tenant> {
      return resolveTenantByHost(host, tenantStore)
    },
    async loadClient(clientId: string) {
      // loadClientMetadata throws unless dpop_bound_access_tokens === true,
      // so the narrowed (non-optional) shape is satisfied at runtime.
      const m = await loadClientMetadata(clientId)
      return {
        client_id: m.client_id,
        redirect_uris: m.redirect_uris,
        dpop_bound_access_tokens: m.dpop_bound_access_tokens === true,
      }
    },
    async sendMagicLink({ email, oauthCode }) {
      const token = randomBytes(24).toString('base64url')
      const ttl = Math.floor(Date.now() / 1000) + 900
      await doc.send(new PutCommand({
        TableName: magicTable,
        Item: { token, email, oauthCode, createdAt: Date.now(), ttl },
      }))
      const verifyUrl = `https://${domain}/auth/verify?token=${encodeURIComponent(token)}`
      await sendMagicLinkEmailRaw(email, verifyUrl)
    },
    async verifyDpop(proof: string, c: { htm: string; htu: string }) {
      return verifyDpopProof(proof, {
        htm: c.htm,
        htu: c.htu,
        seenJti: (j: string) => store.seenJti(j, 300),
      })
    },
    async makeAccess(tenant: Tenant, jkt: string) {
      return makeAccessFor(tenant, await getJwtSecret(), jkt)
    },
  }
}

function parseBody(raw: string, contentType: string): Record<string, any> {
  if (!raw) return {}
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const out: Record<string, string> = {}
    for (const [k, v] of new URLSearchParams(raw).entries()) out[k] = v
    return out
  }
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method
  const path = (event.rawPath || '').split('?')[0]
  const headers = event.headers || {}

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  // Merge query params + parsed body into a single params object.
  const params: Record<string, any> = {}
  for (const [k, v] of Object.entries(event.queryStringParameters || {})) {
    if (v !== undefined) params[k] = v
  }
  if (event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body
    const ct = headers['content-type'] || headers['Content-Type'] || ''
    Object.assign(params, parseBody(raw, ct))
  }
  // Surface the DPoP request header to routeOAuth (token endpoint reads it).
  const dpop = headers['dpop'] || headers['DPoP']
  if (dpop) params.__dpop = dpop

  try {
    const result = await routeOAuth(method, path, params, buildDeps(), headers as Record<string, string>)
    return {
      statusCode: result.status,
      headers: {
        'content-type': result.contentType ?? 'application/json',
        ...CORS,
        ...(result.headers || {}),
      },
      body: result.body,
    }
  } catch (err) {
    console.error('[atproto-oauth] handler error', err)
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json', ...CORS },
      body: JSON.stringify({ error: 'server_error' }),
    }
  }
}
