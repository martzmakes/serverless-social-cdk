/**
 * ap/host.ts — canonical public AP host per actor.
 *
 * Every AP URL for a tenant (actor id, inbox, outbox, key id, Note ids, ...)
 * and the host a remote signs for that tenant's inbox is derived from the
 * handle via these helpers — NEVER from a request header (CloudFront rewrites
 * Host, and an attacker controls everything else).
 *
 * `customHosts` is the allowlist from env AP_CUSTOM_HOSTS (comma separated).
 * A tenant whose handle is in the list is served from its own host
 * (martzmakes.com); every other tenant stays on the apex host.
 */
import { HANDLE, PDS_ENDPOINT } from '../pds/lexicons'

export function parseCustomHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function canonicalApHost(handle: string, customHosts: string[]): string {
  return customHosts.includes(handle.toLowerCase()) ? handle.toLowerCase() : HANDLE
}

/** https origin for the tenant's canonical host (apex keeps PDS_ENDPOINT). */
export function canonicalApOrigin(
  handle: string,
  customHosts: string[],
): string {
  const host = canonicalApHost(handle, customHosts)
  return host === HANDLE ? PDS_ENDPOINT : `https://${host}`
}

/**
 * Origin of a tenant's PUBLIC WEB PAGES (where `/<slug>` longform HTML lives).
 * Mirrors pds/longform-tenant.ts renderTargetForTenant: the apex serves
 * `https://serverless.social/<slug>`; every other tenant serves
 * `https://<handle>/<slug>`. NOT the same as canonicalApOrigin: a non-custom
 * sub-user's AP identity is on serverless.social but its pages are on its own
 * handle host, and an Article url that pointed at the AP origin would 404.
 */
export function pageOriginFor(handle: string): string {
  return handle.toLowerCase() === HANDLE ? PDS_ENDPOINT : `https://${handle.toLowerCase()}`
}
