// ---------------------------------------------------------------------------
// authoritative-dns.ts — shared authoritative-NS TXT resolution (the G1
// negative-TTL defense).
//
// A recursive resolver caches a NEGATIVE answer for `_atproto.<handle>` for the
// zone's negative-TTL when the record does not yet exist. Immediately after a
// Route53 UPSERT, a recursive / single-shot query (node:dns/promises
// resolveTxt) races propagation and can hit the documented Phase-D G1
// negative-TTL trap → a false FAIL. The selfserve-live-proof harness was
// hardened for exactly this; this module is the extracted, single-sourced
// version of that logic so the production --approve / provisionSubuser handle
// verification uses the SAME proven authoritative+bounded-poll path.
//
// Mechanism:
//   1. resolveNs(zone) → the zone's authoritative nameserver hostnames
//      (recursive is fine: the NS set is stable and is NOT the record under
//      test).
//   2. resolve each NS hostname to A records.
//   3. build a node:dns Resolver pinned (setServers) to those authoritative
//      IPs and query `_atproto.<handle>` TXT THERE — bypassing every recursive
//      negative cache. Route53 serves the change from its own authoritative NS
//      within seconds of the change-batch applying.
//
// No new npm dependency: uses only node:dns/promises primitives (the same the
// harness uses).
// ---------------------------------------------------------------------------

import { Resolver, resolveNs } from 'node:dns/promises'

// Bounded poll: covers Route53 change propagation to its OWN authoritative NS
// (seconds, not the recursive negative-TTL of 300s). Same magnitude as the
// selfserve-live-proof harness (DNS_POLL_TIMEOUT_MS / DNS_POLL_INTERVAL_MS).
export const DNS_POLL_TIMEOUT_MS = 4 * 60 * 1000
export const DNS_POLL_INTERVAL_MS = 5_000

export async function authoritativeNsIps(zone: string): Promise<string[]> {
  const nsHosts = await resolveNs(zone) // recursive is fine: NS set is stable
  const ips: string[] = []
  for (const host of nsHosts) {
    try {
      // NS hostnames resolve via the default resolver; these are NOT the
      // record under test, so recursive caching here is harmless.
      const r = new Resolver()
      const a = await r.resolve4(host)
      ips.push(...a)
    } catch {
      /* try the next NS */
    }
  }
  if (ips.length === 0) {
    throw new Error(`authoritativeNsIps: no A records for any NS of ${zone} (${nsHosts.join(',')})`)
  }
  return ips
}

export interface TxtProbe {
  found: boolean
  values: string[]
}

export async function queryAuthoritativeTxt(
  authoritativeIps: string[],
  name: string,
): Promise<TxtProbe> {
  const r = new Resolver()
  r.setServers(authoritativeIps)
  try {
    const records = await r.resolveTxt(name)
    const values = records.map((chunks) => chunks.join(''))
    return { found: values.length > 0, values }
  } catch (e: any) {
    // ENOTFOUND / ENODATA from the AUTHORITATIVE server is a trustworthy
    // "no such record" (not a recursive negative-cache artifact).
    const code = e?.code ?? ''
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { found: false, values: [] }
    throw e
  }
}
