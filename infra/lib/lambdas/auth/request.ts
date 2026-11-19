import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { sendMagicLinkEmail } from "./lib/email";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAGIC_LINK_TOKENS_TABLE = process.env.MAGIC_LINK_TOKENS_TABLE!;
const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL!;
const WAITLIST_TABLE = process.env.WAITLIST_TABLE;
const PROJECT_SLUG = process.env.PROJECT_SLUG || "unknown";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ALLOWED_EMAILS is set at deploy time (comma-separated).
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// -------------------------------------------------------------------------
// Host-aware magic-link redirect (audit-2026-09-01 finding
// auth-flow-live-validation-2). martzmakes.com is served by this same stack
// (docs/architecture.md, "How martzmakes.com is served"); a sign-in
// requested from martzmakes.com should land back on martzmakes.com's own
// /auth/complete, not always the apex. The only reliable signal for that at
// /auth/verify time is whatever we capture and persist here, at request
// time — verify.ts's link is the raw API Gateway URL from the emailed link
// (VERIFY_BASE_URL), not proxied through CloudFront, so it has no Host /
// x-pds-viewer-host header of its own to read.
//
// Kept as a narrow, explicit allowlist (not a TenantsTable lookup) because
// this value gates a redirect target: an unvalidated Origin header would be
// an open-redirect vector via a crafted /auth/request call.
// -------------------------------------------------------------------------
function knownTenantHosts(): string[] {
  return (process.env.KNOWN_TENANT_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Extracts the browser's page origin from the /auth/request fetch — its
 * `Origin` header, sent automatically on cross-origin requests, which this
 * one always is today (EXPO_PUBLIC_AUTH_API_URL is a single build-time
 * value shared by both hosts) — and validates it against the known-tenant
 * allowlist. Falls back to `Referer` for the rare client that omits Origin.
 * `www.<tenant>` folds to the bare tenant host: it only ever 301s at the CDN
 * edge and never itself issues this fetch. Returns undefined for anything
 * missing, unparsable, or not a recognized tenant host — verify.ts's
 * `resolveSiteUrl` then falls back to the apex SITE_URL, matching every
 * sign-in's behavior before this change (including serverless.social's own).
 */
export function resolveOriginHost(
  headers: Record<string, string | undefined> | undefined
): string | undefined {
  const raw = headers?.origin || headers?.referer;
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(raw).host.toLowerCase();
  } catch {
    return undefined;
  }
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return knownTenantHosts().includes(bare) ? bare : undefined;
}

function response(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (event.requestContext.http.method === "OPTIONS") {
    return response(204, {});
  }

  let parsed: { email?: string };
  try {
    parsed = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "invalid_json" });
  }

  const email = (parsed.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return response(400, { error: "invalid_email" });
  }

  // Non-allowlisted → waitlist. Interested visitors are captured as a demand
  // signal instead of silently dropped. Allowlisted owner email falls through
  // to magic-link. Response is identical either way — no enumeration leak.
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
              referrer: (parsed as { referrer?: string }).referrer || null,
            },
            // Don't overwrite an earlier signup timestamp for the same email.
            ConditionExpression: "attribute_not_exists(email)",
          })
        );
        console.log("waitlist_signup", { email, prototype: PROJECT_SLUG });
      } catch (err) {
        // ConditionalCheckFailed = already on the list; anything else we
        // swallow so the UX still shows success (don't leak storage state).
        console.log("waitlist_put_noop_or_error", {
          email,
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
    return response(200, { ok: true });
  }

  const token = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = nowSeconds + 15 * 60; // 15 minutes
  const originHost = resolveOriginHost(event.headers);

  await ddb.send(
    new PutCommand({
      TableName: MAGIC_LINK_TOKENS_TABLE,
      Item: {
        token,
        email,
        createdAt: Date.now(),
        ttl,
        // Only set when the request came from a recognized tenant host
        // (see resolveOriginHost above); absent for serverless.social itself
        // and for anything unrecognized, so verify.ts's fallback to the
        // apex SITE_URL is byte-identical to pre-fix behavior.
        ...(originHost ? { originHost } : {}),
      },
    })
  );

  const verifyUrl = `${VERIFY_BASE_URL}?token=${encodeURIComponent(token)}`;

  try {
    await sendMagicLinkEmail(email, verifyUrl);
  } catch (err) {
    console.error("sendMagicLinkEmail failed", err);
    // Still return ok — don't leak whether SES delivered.
  }

  // Always return ok — don't reveal whether the email exists.
  return response(200, { ok: true });
};
