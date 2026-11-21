// OAuth 2.1 + PKCE handler for MCP clients (Claude Desktop, etc).
//
// Implements the minimal OAuth server an MCP "remote connector" expects:
//   RFC 9728 — Protected Resource Metadata
//   RFC 8414 — Authorization Server Metadata
//   RFC 7591 — Dynamic Client Registration
//   RFC 7636 — PKCE
//
// Approval is gated by the magic-link sign-in (no bearer tokens copied by
// hand). When the user clicks the magic link, `auth/verify.ts` notices the
// `oauthCode` rider and approves this auth request, then redirects back to
// the client's callback.
//
// Endpoints (all served by this Lambda):
//   GET  /.well-known/mcp-oauth-authorization-server
//   POST /oauth/register
//   GET  /oauth/authorize
//   POST /oauth/email
//   POST /oauth/token
//
// Delete this whole file (and the OAuth block in infra-stack.ts) if you
// don't expose an MCP server to remote clients.

import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import {
  issueRefreshToken,
  consumeRefreshToken,
} from "./refresh-tokens";
import { verifyJwt } from "../auth/lib/jwt";
import {
  ACCESS_TOKEN_TTL_SECONDS, MCP_SCOPES, WRITE_SCOPE, mcpResource,
  mintMcpToken, normalizeMcpScope, oauthResourceMatches,
} from "../mcp/auth";
import { sendMagicLinkEmail } from "../auth/lib/email";
import QRCode from "qrcode";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const OAUTH_TABLE = process.env.OAUTH_TABLE!;
const MAGIC_LINK_TOKENS_TABLE = process.env.MAGIC_LINK_TOKENS_TABLE!;
const PROJECT_SLUG = process.env.PROJECT_SLUG!;
const SITE_URL = process.env.SITE_URL!;
const WAITLIST_TABLE = process.env.WAITLIST_TABLE;

// Allowlist gate — mirrors auth/request.ts exactly.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const SSO_COOKIE_NAME = `${PROJECT_SLUG}_sso`;
const AUTH_CODE_TTL_SECONDS = 15 * 60;
const CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAGIC_LINK_TTL_SECONDS = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthRequest {
  authCode: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  scope: string;
  resource: string;
  approved: boolean;
  email?: string;
  // Random secret embedded in the SSO consent form; the POST must echo it.
  // Bound to this auth request (a different authCode has a different token),
  // never sent anywhere a cross-site page can read it.
  consentToken?: string;
  consentEmail?: string;
  expiresAt: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-expose-headers": "location",
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function html(statusCode: number, body: string) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
    body,
  };
}

function errorJson(code: string, description: string, statusCode = 400) {
  return json(statusCode, { error: code, error_description: description });
}

function parseFormBody(body: string | null): Record<string, string> {
  if (!body) return {};
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function readBody(event: { body?: string | null; isBase64Encoded?: boolean }): string {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf-8");
  }
  return event.body;
}

// API Gateway HTTP API (payload v2) delivers cookies in the `event.cookies`
// array and STRIPS the Cookie header from `event.headers` — so reading
// headers.cookie always came up empty and the SSO fast-path never fired.
// Mirrors auth/session.ts::cookieValue.
function cookieValue(cookies: string[] | undefined, name: string): string | null {
  for (const c of cookies ?? []) {
    const eq = c.indexOf("=");
    if (eq <= 0) continue;
    if (c.slice(0, eq).trim() === name) {
      return decodeURIComponent(c.slice(eq + 1).trim());
    }
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
// Schemes that must never be a redirect target, registered or not.
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  "javascript:", "data:", "vbscript:", "file:", "blob:", "about:",
]);

function parseRedirect(u: string): URL | null {
  try {
    const url = new URL(u);
    if (FORBIDDEN_REDIRECT_SCHEMES.has(url.protocol)) return null;
    // Registered public MCP callbacks must use HTTPS, except native loopback.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return null;
    if (url.username || url.password) return null;
    if (url.hash) return null; // RFC 6749 3.1.2: no fragment
    return url;
  } catch {
    return null;
  }
}

// RFC 6749 3.1.2.3 exact match; RFC 8252 7.3 loopback exception: for an
// http loopback redirect the port is ignored (scheme, host, path, query must
// still match). Anything else must match the registered string exactly.
export function isAllowedRedirect(registered: string[], presented: string): boolean {
  const p = parseRedirect(presented);
  if (!p) return false;
  for (const r of registered) {
    if (!parseRedirect(r)) continue;
    if (r === presented) return true;
    const reg = new URL(r);
    if (
      reg.protocol === "http:" &&
      p.protocol === "http:" &&
      LOOPBACK_HOSTS.has(reg.hostname) &&
      reg.hostname === p.hostname &&
      reg.pathname === p.pathname &&
      reg.search === p.search
    ) {
      return true;
    }
  }
  return false;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function validatePkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const hash = createHash("sha256").update(verifier).digest();
  return base64url(hash) === challenge;
}

// CloudFront strips Host via ALL_VIEWER_EXCEPT_HOST_HEADER, so reading it
// would return execute-api.*. Use the env-pinned public URL.
function getBaseUrl(): string {
  return SITE_URL;
}

// ---------------------------------------------------------------------------
// DDB
// ---------------------------------------------------------------------------

async function putClient(c: RegisteredClient) {
  await ddb.send(
    new PutCommand({
      TableName: OAUTH_TABLE,
      Item: {
        pk: `CLIENT#${c.clientId}`,
        sk: "CLIENT",
        ...c,
        ttl: Math.floor(Date.now() / 1000) + CLIENT_TTL_SECONDS,
      },
    })
  );
}

async function getClient(clientId: string): Promise<RegisteredClient | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `CLIENT#${clientId}`, sk: "CLIENT" },
    })
  );
  return (res.Item as RegisteredClient) || null;
}

async function putAuthRequest(a: AuthRequest, previousConsent?: string) {
  await ddb.send(
    new PutCommand({
      TableName: OAUTH_TABLE,
      Item: {
        pk: `AUTH#${a.authCode}`,
        sk: "AUTH",
        ...a,
        ttl: Math.floor(a.expiresAt / 1000),
      },
      ...(previousConsent ? {
        ConditionExpression: "consentToken = :consent AND approved = :pending",
        ExpressionAttributeValues: { ":consent": previousConsent, ":pending": false },
      } : {}),
    })
  );
}

async function getAuthRequest(authCode: string): Promise<AuthRequest | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `AUTH#${authCode}`, sk: "AUTH" },
      ConsistentRead: true,
    })
  );
  return (res.Item as AuthRequest) || null;
}

async function deleteAuthRequest(authCode: string) {
  await ddb.send(
    new DeleteCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `AUTH#${authCode}`, sk: "AUTH" },
    })
  );
}

// Refresh tokens live in ./refresh-tokens.ts — opaque high-entropy strings,
// only sha256(token) persisted, rotated with a reuse-grace window so the
// connector's concurrent/retried refreshes don't strand it (the macrovault
// delete-on-use bug, 2026-05-18; nightswarm hit the same strand 2026-07-23).

// ---------------------------------------------------------------------------
// Discovery (well-known)
// ---------------------------------------------------------------------------

// The MCP resource / OAuth issuer is the path-scoped `${baseUrl}/mcp` — DISTINCT
// from the AT-Proto OAuth server, which owns the canonical root paths
// (/.well-known/oauth-authorization-server + /.well-known/oauth-protected-resource)
// and mandates PAR + DPoP. Using a /mcp-scoped resource + issuer is what lets a
// standards-compliant MCP client (Claude Desktop / Claude Code) do RFC 8414
// path-aware discovery and land on THIS magic-link AS instead of the PAR-only
// AT-Proto one. (Pre-fix, the MCP pointed clients at the AT-Proto PRM → "PAR
// required".)
// RFC 9728 Protected Resource Metadata for the MCP resource. `authorization_servers`
// is the ISSUER identifier (not a metadata URL) so the client performs RFC 8414
// discovery against `${baseUrl}/mcp` → /.well-known/oauth-authorization-server/mcp.
function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: mcpResource(baseUrl),
    authorization_servers: [mcpResource(baseUrl)],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(baseUrl: string) {
  return {
    // MUST equal the discovery issuer the client used to build the well-known URL.
    issuer: mcpResource(baseUrl),
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: MCP_SCOPES,
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${baseUrl}/`,
  };
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleRegister(raw: string) {
  if (Buffer.byteLength(raw) > 8192) return errorJson("invalid_request", "Registration is too large");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorJson("invalid_request", "Expected a registration object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorJson("invalid_request", "Invalid JSON body");
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as string[])
    : [];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return errorJson("invalid_redirect_uri", "Provide 1 to 10 redirect URIs");
  }
  if (
    !redirectUris.every((u) => typeof u === "string" && u.length <= 2048 && parseRedirect(u) !== null)
  ) {
    return errorJson("invalid_redirect_uri", "redirect_uris must be valid absolute URIs");
  }
  const clientId = randomUUID();
  const clientName =
    typeof body.client_name === "string" && body.client_name
      ? body.client_name.slice(0, 120)
      : `Client ${clientId.slice(0, 8)}`;
  const client: RegisteredClient = {
    clientId,
    clientName,
    redirectUris,
    createdAt: Date.now(),
  };
  await putClient(client);
  return {
    statusCode: 201,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }),
  };
}

async function handleAuthorize(
  params: Record<string, string | undefined>,
  baseUrl: string,
  cookies: string[] | undefined
) {
  const {
    client_id,
    redirect_uri,
    response_type,
    code_challenge,
    code_challenge_method,
    state,
    scope,
    resource,
  } = params;

  if (!client_id) return errorJson("invalid_request", "client_id is required");
  if (!redirect_uri) return errorJson("invalid_request", "redirect_uri is required");
  if (response_type !== "code")
    return errorJson("unsupported_response_type", "Only code is supported");
  if (!code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(code_challenge))
    return errorJson("invalid_request", "An S256 code challenge is required");
  if (code_challenge_method !== "S256")
    return errorJson("invalid_request", "Only S256 is supported");

  const audience = mcpResource(baseUrl);
  if (!oauthResourceMatches(resource, audience)) return errorJson("invalid_target", "Unknown MCP resource");
  const grantedScope = normalizeMcpScope(scope);
  if (!grantedScope) return errorJson("invalid_scope", "Request supported MCP scopes");

  // Validate BEFORE persisting anything or redirecting anywhere: an
  // unknown client or unregistered redirect_uri must never reach a
  // redirect (open-redirect / code-theft vector).
  const client = await getClient(client_id);
  if (!client) return errorJson("invalid_client", "Unknown client_id");
  if (!isAllowedRedirect(client.redirectUris || [], redirect_uri)) {
    return errorJson("invalid_request", "redirect_uri is not registered for this client");
  }
  const clientName = client.clientName || "Application";

  const authCode = randomUUID();
  const authRequest: AuthRequest = {
    authCode,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    state,
    scope: grantedScope,
    resource: audience,
    approved: false,
    expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
    createdAt: Date.now(),
  };
  await putAuthRequest(authRequest);

  // SSO path: a valid session cookie means we know WHO the user is, but not
  // that they intend to authorize THIS client. Show a consent page instead of
  // auto-approving; the code is only issued on a POST carrying consentToken.
  const ssoJwt = cookieValue(cookies, SSO_COOKIE_NAME);
  if (ssoJwt) {
    try {
      const { email } = await verifyJwt(ssoJwt);
      if (ALLOWED_EMAILS.includes(email)) {
        const consentToken = base64url(randomBytes(32));
        await putAuthRequest({ ...authRequest, consentToken, consentEmail: email });
        return html(
          200,
          renderConsentPage({
            clientName,
            redirectUri: redirect_uri,
            authCode,
            consentToken,
            email,
            scope: grantedScope,
          })
        );
      }
    } catch {
      // Stale / invalid cookie — fall through to sign-in page.
    }
  }

  const handoff = new URL("/oauth/authorize", baseUrl);
  // A second browser starts the same authorization with the original PKCE
  // parameters, before the user's approval in that browser.
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) handoff.searchParams.set(key, value);
  });
  const handoffUrl = handoff.href;
  let qrDataUrl = "";
  try {
    if (!LOOPBACK_HOSTS.has(new URL(redirect_uri).hostname)) {
      qrDataUrl = await QRCode.toDataURL(handoffUrl, { width: 220, margin: 1 });
    }
  } catch {
    qrDataUrl = "";
  }

  return html(200, renderSignInPage({ clientName, authCode, qrDataUrl, scope: grantedScope }));
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function handleConsent(
  raw: string,
  cookies: string[] | undefined
) {
  const form = parseFormBody(raw);
  const authCode = (form.auth_code || "").trim();
  const presentedToken = form.consent_token || "";
  if (!authCode || !presentedToken) {
    return errorJson("invalid_request", "auth_code and consent_token are required");
  }
  const authRequest = await getAuthRequest(authCode);
  if (!authRequest || authRequest.expiresAt < Date.now()) {
    return errorJson("invalid_grant", "unknown or expired authorization");
  }
  if (
    !authRequest.consentToken ||
    authRequest.approved ||
    !safeEqual(authRequest.consentToken, presentedToken)
  ) {
    return errorJson("invalid_request", "invalid consent token");
  }
  // The approver must still be the signed-in user.
  const ssoJwt = cookieValue(cookies, SSO_COOKIE_NAME);
  let email: string | undefined;
  if (ssoJwt) {
    try {
      email = (await verifyJwt(ssoJwt)).email;
    } catch {
      email = undefined;
    }
  }
  if (!email || !ALLOWED_EMAILS.includes(email) || email !== authRequest.consentEmail) return errorJson("access_denied", "Sign in again to review access", 401);

  // Re-check the stored redirect against the client's registration.
  const client = await getClient(authRequest.clientId);
  if (!client || !isAllowedRedirect(client.redirectUris || [], authRequest.redirectUri)) {
    return errorJson("invalid_request", "redirect_uri is not registered for this client");
  }

  const callback = new URL(authRequest.redirectUri);
  callback.searchParams.set("iss", authRequest.resource);
  if (form.decision === "deny") {
    await deleteAuthRequest(authCode);
    callback.searchParams.set("error", "access_denied");
    if (authRequest.state) callback.searchParams.set("state", authRequest.state);
    return {
      statusCode: 302,
      headers: { location: callback.toString(), "cache-control": "no-store", ...CORS_HEADERS },
      body: "",
    };
  }

  // Single use: drop the token as we approve.
  const { consentToken: _used, consentEmail: _identity, ...rest } = authRequest;
  try {
    await putAuthRequest({ ...rest, approved: true, email }, presentedToken);
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") {
      return errorJson("invalid_grant", "Authorization has already been processed");
    }
    throw error;
  }
  callback.searchParams.set("code", authCode);
  if (authRequest.state) callback.searchParams.set("state", authRequest.state);
  return {
    statusCode: 302,
    headers: { location: callback.toString(), "cache-control": "no-store", ...CORS_HEADERS },
    body: "",
  };
}

async function handleEmail(raw: string, baseUrl: string) {
  const form = parseFormBody(raw);
  const email = (form.email || "").trim().toLowerCase();
  const oauthCode = (form.oauth_code || form.oauthCode || "").trim();
  if (!email || !EMAIL_RE.test(email)) {
    return errorJson("invalid_request", "valid email is required");
  }
  if (!oauthCode) return errorJson("invalid_request", "oauth_code is required");

  const authRequest = await getAuthRequest(oauthCode);
  if (!authRequest) return errorJson("invalid_grant", "unknown authorization");
  if (authRequest.expiresAt < Date.now() || authRequest.approved || authRequest.resource !== mcpResource(baseUrl)) {
    return errorJson("invalid_grant", "Authorization expired or already used");
  }

  // Allowlist gate — same logic as auth/request.ts. Non-allowlisted emails
  // get a best-effort waitlist write and the same success page, so the
  // response is indistinguishable. No token minted, no SES call.
  if (!ALLOWED_EMAILS.includes(email)) {
    if (WAITLIST_TABLE) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: WAITLIST_TABLE,
            Item: {
              email,
              prototype: PROJECT_SLUG,
              createdAt: Date.now(),
              createdAtIso: new Date().toISOString(),
              referrer: null,
            },
            ConditionExpression: "attribute_not_exists(email)",
          })
        );
        console.log("waitlist_signup", { email, prototype: PROJECT_SLUG });
      } catch (err) {
        console.log("waitlist_put_noop_or_error", {
          email,
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
    return html(200, renderEmailSentPage(email));
  }

  // Mint a magic-link token that carries the oauthCode — when the verify
  // Lambda consumes it, it'll approve the OAuth request and redirect.
  const magicToken = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: MAGIC_LINK_TOKENS_TABLE,
      Item: {
        token: magicToken,
        email,
        oauthCode,
        createdAt: Date.now(),
        ttl: nowSeconds + MAGIC_LINK_TTL_SECONDS,
      },
    })
  );

  const verifyUrl = `${baseUrl}/auth/verify?token=${encodeURIComponent(magicToken)}`;
  try {
    await sendMagicLinkEmail(email, verifyUrl);
  } catch (err) {
    console.error("sendMagicLinkEmail failed", err);
  }

  return html(200, renderEmailSentPage(email));
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    }),
  };
}

async function handleToken(raw: string, contentType: string) {
  let body: Record<string, string>;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    body = parseFormBody(raw);
  } else {
    try {
      const parsed: unknown = JSON.parse(raw || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          Object.values(parsed).some(value => typeof value !== "string")) {
        return errorJson("invalid_request", "Expected a token request with string parameters");
      }
      body = parsed as Record<string, string>;
    } catch {
      return errorJson("invalid_request", "Invalid request body");
    }
  }
  const { grant_type } = body;
  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(body);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(body);
  }
  return errorJson(
    "unsupported_grant_type",
    `Unsupported grant_type: ${grant_type}`
  );
}

async function handleAuthorizationCodeGrant(body: Record<string, string>) {
  const { code, code_verifier, client_id, redirect_uri, resource } = body;
  const audience = mcpResource(getBaseUrl());
  if (!oauthResourceMatches(resource, audience)) return errorJson("invalid_target", "Unknown MCP resource");
  if (!code) return errorJson("invalid_request", "code is required");
  if (!code_verifier) return errorJson("invalid_request", "code_verifier is required");
  // OAuth 2.1: public clients include client_id on token requests. Binding
  // the exchange to the client the code was issued to.
  if (!client_id) return errorJson("invalid_request", "client_id is required");

  const authRequest = await getAuthRequest(code);
  if (!authRequest)
    return errorJson("invalid_grant", "Invalid or expired authorization code");
  if (authRequest.expiresAt < Date.now()) {
    await deleteAuthRequest(code);
    return errorJson("invalid_grant", "Authorization code has expired");
  }
  if (!authRequest.approved || !authRequest.email || !ALLOWED_EMAILS.includes(authRequest.email)) {
    return errorJson("authorization_pending", "Authorization is pending");
  }
  if (authRequest.resource !== audience || authRequest.clientId !== client_id || authRequest.redirectUri !== redirect_uri) {
    return errorJson("invalid_grant", "Code grant does not match this request");
  }
  if (!validatePkce(code_verifier, authRequest.codeChallenge)) {
    return errorJson("invalid_grant", "PKCE verification failed");
  }

  try {
    await ddb.send(new DeleteCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `AUTH#${code}`, sk: "AUTH" },
      ConditionExpression: "approved = :approved AND email = :email AND expiresAt >= :now",
      ExpressionAttributeValues: { ":approved": true, ":email": authRequest.email, ":now": Date.now() },
    }));
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") {
      return errorJson("invalid_grant", "Invalid or expired authorization code");
    }
    throw error;
  }

  const accessToken = await mintMcpToken(authRequest.email, authRequest.scope, audience);
  const refreshToken = await issueRefreshToken(ddb, OAUTH_TABLE, {
    email: authRequest.email, clientId: client_id, scope: authRequest.scope, resource: audience,
  });

  return tokenResponse(accessToken, refreshToken, authRequest.scope);
}

// refresh_token grant (OAuth 2.1, RFC 6749 §6) with rotation: the presented
// token is invalidated and a brand-new one is returned. This is what lets
// Claude's MCP connector silently renew instead of expiring.
async function handleRefreshTokenGrant(body: Record<string, string>) {
  const { refresh_token, client_id, resource, scope } = body;
  const audience = mcpResource(getBaseUrl());
  if (!oauthResourceMatches(resource, audience)) return errorJson("invalid_target", "Unknown MCP resource");
  if (!refresh_token || !client_id) return errorJson("invalid_request", "refresh_token and client_id are required");

  const requestedScope = scope === undefined ? undefined : normalizeMcpScope(scope);
  if (scope !== undefined && !requestedScope) return errorJson("invalid_scope", "Request supported MCP scopes");

  const rec = await consumeRefreshToken(ddb, OAUTH_TABLE, refresh_token, {
    clientId: client_id, resource: audience, scope: requestedScope, allowedEmails: ALLOWED_EMAILS,
  });
  if (!rec) return errorJson("invalid_grant", "Invalid or expired refresh token");
  const grantedScope = requestedScope ?? rec.scope;
  const accessToken = await mintMcpToken(rec.email, grantedScope, audience);

  return tokenResponse(accessToken, rec.rotatedRefreshToken, grantedScope);
}

// ---------------------------------------------------------------------------
// HTML — uses the martzmakes design palette to match the rest of the app
// ---------------------------------------------------------------------------

const PAGE_STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'General Sans', -apple-system, Segoe UI, Roboto, sans-serif;
    background: #07090C;
    color: #EEF1F6;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    letter-spacing: -0.01em;
  }
  .card {
    background: #11151C; border: 1px solid rgba(255,255,255,0.10);
    border-radius: 10px; padding: 32px;
    max-width: 440px; width: 100%;
  }
  .eyebrow {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 11px; letter-spacing: 0.08em;
    color: #8892A0; text-transform: uppercase;
    margin-bottom: 12px;
  }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 6px; }
  .sub { color: #B8C0CC; font-size: 14px; line-height: 20px; margin-bottom: 24px; }
  .client { color: #3B82FF; font-weight: 600; }
  .qr-row {
    display: flex; gap: 16px; align-items: center;
    background: #0B0E13; border: 1px solid rgba(255,255,255,0.10);
    border-radius: 8px; padding: 16px; margin-bottom: 24px;
  }
  .qr-row img { width: 96px; height: 96px; border-radius: 6px; background: #fff; padding: 4px; }
  .qr-copy { font-size: 12px; color: #8892A0; line-height: 18px; }
  label {
    display: block; color: #8892A0; font-size: 11px;
    margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em;
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  }
  input[type=email] {
    width: 100%; background: #171C25; color: #EEF1F6;
    border: 1px solid rgba(255,255,255,0.10); border-radius: 6px;
    padding: 12px; font-size: 15px; outline: none;
    font-family: 'General Sans', -apple-system, sans-serif;
  }
  input[type=email]:focus { border-color: #3B82FF; }
  button {
    width: 100%; margin-top: 16px;
    background: #3B82FF; color: #fff; border: 0;
    border-radius: 6px; padding: 12px; font-size: 14px; font-weight: 500;
    cursor: pointer;
    font-family: 'General Sans', -apple-system, sans-serif;
  }
  button:hover { background: #5897FF; }
  .hint { color: #5D6674; font-size: 12px; text-align: center; margin-top: 12px; }
  .email-pill { color: #3B82FF; font-weight: 600; }
`;

function describeScope(scope: string) {
  return scope.split(" ").includes(WRITE_SCOPE)
    ? "Read account and analytics data, publish posts and articles, and delete published records."
    : "Read account and analytics data.";
}

function renderSignInPage(args: {
  clientName: string;
  authCode: string;
  qrDataUrl: string;
  scope: string;
}): string {
  const escaped = escapeHtml(args.clientName);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${escaped}</title>
<style>${PAGE_STYLES}</style>
</head><body>
<div class="card">
  <div class="eyebrow">CONNECT</div>
  <h1>Authorize access</h1>
  <p class="sub"><span class="client">${escaped}</span> requests permission to:</p>
  <p class="sub">${describeScope(args.scope)}</p>
  ${
    args.qrDataUrl
      ? `<div class="qr-row">
      <img src="${args.qrDataUrl}" alt="QR code" />
      <div class="qr-copy">On your phone? Scan to open the sign-in page on your phone.</div>
    </div>`
      : ""
  }
  <form method="POST" action="/oauth/email">
    <input type="hidden" name="oauth_code" value="${escapeHtml(args.authCode)}" />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" />
    <button type="submit">Send sign-in link</button>
  </form>
  <p class="hint">No passwords. We'll email a one-time link that completes the connection.</p>
</div>
</body></html>`;
}

// Host shown on the consent page. URL.host is already punycode for IDNs, so
// look-alike unicode hosts render as xn-- forms. Custom schemes with no host
// (e.g. cursor://) show the scheme instead.
function redirectDisplay(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return "(invalid redirect)";
  }
}

function renderConsentPage(args: {
  clientName: string;
  redirectUri: string;
  authCode: string;
  consentToken: string;
  email: string;
  scope: string;
}): string {
  const name = escapeHtml(args.clientName);
  const dest = escapeHtml(redirectDisplay(args.redirectUri));
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${name}</title>
<style>${PAGE_STYLES} .row { display: flex; gap: 12px; } .row button { margin-top: 16px; } button.secondary { background: #171C25; border: 1px solid rgba(255,255,255,0.10); color: #B8C0CC; } button.secondary:hover { background: #1F2530; } .dest { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 13px; color: #EEF1F6; word-break: break-all; }</style>
</head><body>
<div class="card">
  <div class="eyebrow">CONNECT</div>
  <h1>Authorize access</h1>
  <p class="sub"><span class="client">${name}</span> wants to access your account via MCP, signed in as <span class="email-pill">${escapeHtml(args.email)}</span>.</p>
  <p class="sub">${describeScope(args.scope)}</p>
  <div class="qr-row"><div class="qr-copy">After you approve, you will be sent back to<br /><span class="dest">${dest}</span><br />Only continue if you started this connection and recognize that address.</div></div>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="auth_code" value="${escapeHtml(args.authCode)}" />
    <input type="hidden" name="consent_token" value="${escapeHtml(args.consentToken)}" />
    <div class="row">
      <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
      <button type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
</div>
</body></html>`;
}

function renderEmailSentPage(email: string): string {
  const escaped = escapeHtml(email);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Check your email</title>
<style>${PAGE_STYLES} .card { text-align: center; }</style>
</head><body>
<div class="card">
  <div class="eyebrow">CHECK YOUR EMAIL</div>
  <h1>Sign-in link sent</h1>
  <p class="sub">Sent to <span class="email-pill">${escaped}</span>. Tap the link to finish connecting.</p>
  <p class="hint">Good for 15 minutes. You can close this window — the connector will pick up the session automatically.</p>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath || "";
  const headers = event.headers || {};
  const baseUrl = getBaseUrl();

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    // The CANONICAL /.well-known/oauth-protected-resource + oauth-authorization-server
    // are owned by the atproto-oauth handler (Task 8/G1) and are NOT routed here.
    // The MCP advertises its own resource at the /mcp-scoped paths below — served
    // at both the RFC 8414 path-insertion form (/.well-known/<doc>/mcp) and the
    // OIDC path-append form (/mcp/.well-known/<doc>) so any compliant client
    // resolves the MCP AS (magic-link, no PAR) rather than the AT-Proto one.
    if (
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/mcp/.well-known/oauth-protected-resource"
    ) {
      return json(200, protectedResourceMetadata(baseUrl));
    }
    if (
      path === "/.well-known/oauth-authorization-server/mcp" ||
      path === "/mcp/.well-known/oauth-authorization-server" ||
      // Legacy non-standard path kept for back-compat with anything already wired.
      path === "/.well-known/mcp-oauth-authorization-server"
    ) {
      return json(200, authorizationServerMetadata(baseUrl));
    }
    if (path === "/oauth/register" && method === "POST") {
      return await handleRegister(readBody(event));
    }
    if (path === "/oauth/authorize" && method === "GET") {
      return await handleAuthorize(
        event.queryStringParameters || {},
        baseUrl,
        event.cookies
      );
    }
    if (path === "/oauth/consent" && method === "POST") {
      return await handleConsent(readBody(event), event.cookies);
    }
    if (path === "/oauth/email" && method === "POST") {
      return await handleEmail(readBody(event), baseUrl);
    }
    if (path === "/oauth/token" && method === "POST") {
      const ct = headers["content-type"] || headers["Content-Type"] || "";
      return await handleToken(readBody(event), ct);
    }

    return errorJson("not_found", `Unknown endpoint: ${method} ${path}`, 404);
  } catch (err) {
    console.error("[oauth] handler error", err instanceof Error ? err.name : "Error");
    return errorJson(
      "server_error",
      "The authorization request could not be completed",
      500
    );
  }
};
