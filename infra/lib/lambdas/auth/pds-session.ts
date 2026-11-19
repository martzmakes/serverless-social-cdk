/**
 * pds-session.ts — GET /auth/pds-session
 *
 * Given an app-level magic-link JWT (Authorization: Bearer <jwt>), mints a
 * plain-Bearer DID-scoped xrpc session (accessJwt + refreshJwt) for the
 * caller's chosen entitlement.
 *
 * Entitlement resolution (T1) returns the caller's approved DIDs:
 *  - admin (allow-listed) email: apex synthesized as 'admin', plus any active
 *    tenant rows the email owns (as 'owner').
 *  - sub-user: just the owner tenant row(s) keyed off email.
 *
 * Pick policy (SPA backward-compat lock): prefer the first 'owner' entitlement
 * over the synthesized 'admin' apex. This preserves the OLD short-circuit
 * behavior — an admin email with an active tenant row gets THAT tenant's
 * session (not apex), which the SPA's compose-on-tenant-host flow depends on
 * (e.g. martzmakes.com writes). Admin with no tenant row falls back to apex.
 *
 * Minting (T2) re-validates the picked DID against the entitlement list and
 * recovers the tenant's signingKeyRef before signing. No DPoP on this
 * first-party path — tokens have no `cnf` claim and pass verifyXrpcAuth as
 * plain Bearer.
 */

import type { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { verifyJwt } from './lib/jwt'
import { resolveApprovedDids } from './entitlements'
import { mintFirstPartySessionFor } from './session-mint'

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const ssmClient = new SSMClient({})

// JWT signing secret — cached (same param name + load pattern as pds/handler.ts)
let cachedJwtSecret: Uint8Array | null = null

async function getJwtSecret(): Promise<Uint8Array> {
  if (cachedJwtSecret) return cachedJwtSecret
  const res = await ssmClient.send(
    new GetParameterCommand({
      // JWT_SECRET_PARAM holds the SSM param NAME — same physical path as JWT_SECRET_NAME (read by auth/lib/jwt.ts). Intentional alias, different env key; do not "dedupe".
      Name: process.env.JWT_SECRET_PARAM!,
      WithDecryption: true,
    }),
  )
  const value = res.Parameter?.Value
  if (!value) throw new Error('JWT secret SSM param is empty')
  cachedJwtSecret = new TextEncoder().encode(value)
  return cachedJwtSecret
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function response(statusCode: number, body?: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,OPTIONS',
    },
    body: body ? JSON.stringify(body) : '',
  }
}

async function extractEmail(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader) return null
  const match = /^Bearer\s+(.+)$/i.exec(authHeader)
  if (!match) return null
  try {
    const { email } = await verifyJwt(match[1])
    return email
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method
  if (method === 'OPTIONS') return response(204)
  if (method !== 'GET') return response(405, { error: 'method_not_allowed' })

  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const email = await extractEmail(authHeader)
  if (!email) return response(401, { error: 'unauthorized' })

  const secret = await getJwtSecret()
  // PDS_HANDLE drives apex identity by default (matches pds/lexicons.ts derivation).
  // APEX_DID/APEX_HANDLE overrides exist for tests + future migration flexibility.
  const apexHandle = process.env.APEX_HANDLE ?? process.env.PDS_HANDLE ?? process.env.DOMAIN ?? 'serverless.social'
  const apexDid = process.env.APEX_DID ?? `did:web:${apexHandle}`
  // ALLOWED_EMAILS is the canonical allow-list (already wired in infra-stack.ts authLambdaBase).
  // ADMIN_EMAIL fallback covers the legacy single-admin env var still set on this lambda;
  // T9 will normalize the deploy to ALLOWED_EMAILS exclusively.
  // Use `||` (not `??`) so an empty-string env value falls through to the next fallback —
  // matches auth/request.ts:17 and avoids a silent "no admin synthesis" failure if the
  // ALLOWED_EMAILS env is misconfigured to a blank string.
  const allowedEmails = (process.env.ALLOWED_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const deps = {
    tenantsTable: process.env.TENANTS_TABLE!,
    apexDid,
    apexHandle,
    allowedEmails,
    ddb,
    secret,
  }

  const ents = await resolveApprovedDids(email, deps)
  if (ents.length === 0) return response(404, { error: 'no_tenant' })

  // SPA backward-compat: pick the tenant-owner entitlement first (matches OLD
  // behavior where an admin with an active tenant row got that tenant's session,
  // not apex). Falls back to the first entitlement (apex) when no owner rows.
  // Optional ?did=<did>: the SPA names the identity it is acting as (e.g. the
  // apex admin on the apex host, where createSession no longer mints sessions).
  // Must be one of the caller's approved entitlements or the request fails.
  const wantedDid = event.queryStringParameters?.did
  const pick = wantedDid
    ? ents.find((e) => e.did === wantedDid)
    : (ents.find((e) => e.role === 'owner') ?? ents[0])
  if (!pick) return response(404, { error: 'no_tenant' })
  const s = await mintFirstPartySessionFor(email, pick.did, deps)
  if (!s) return response(404, { error: 'no_tenant' })

  return response(200, {
    did: s.did,
    handle: s.handle,
    accessJwt: s.accessJwt,
    refreshJwt: s.refreshJwt,
  })
}
