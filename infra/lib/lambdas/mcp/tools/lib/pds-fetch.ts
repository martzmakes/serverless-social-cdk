/**
 * pds-fetch.ts — shared HTTP helper for MCP tool handlers calling our PDS.
 *
 * Centralizes the PDS HTTP call surface (createRecord, deleteRecord,
 * uploadBlob, getRecord) so the 4 MCP tools share ONE mocking surface in
 * tests. Throws PdsHttpError on non-2xx with status + parsed body for
 * accurate MCP error mapping.
 *
 * Handles binary uploads (Uint8Array → configurable content-type) and JSON
 * writes uniformly. Supports DI fetchImpl for tests (no nock dep needed).
 */

export class PdsHttpError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`PDS HTTP ${status}`)
    this.name = 'PdsHttpError'
  }
}

export type PdsFetchOpts = {
  /** content-type override for binary uploads (default 'application/octet-stream') */
  contentType?: string
  /** dependency-inject fetch for tests (default globalThis.fetch) */
  fetchImpl?: typeof fetch
  /** override PDS origin (default process.env.PDS_ORIGIN || `https://${DOMAIN}`) */
  origin?: string
}

function resolveOrigin(opts?: PdsFetchOpts): string {
  if (opts?.origin) return opts.origin
  const envOrigin = process.env.PDS_ORIGIN
  if (envOrigin) return envOrigin
  // Fail loud on misconfiguration — a Lambda with neither PDS_ORIGIN nor DOMAIN set
  // should crash at cold-start rather than silently fire real HTTP to a guessed host.
  const domain = process.env.DOMAIN
  if (!domain) {
    throw new Error('pdsFetch: PDS_ORIGIN or DOMAIN env must be set')
  }
  return `https://${domain}`
}

export async function pdsFetch(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  accessJwt: string,
  body?: Record<string, unknown> | Uint8Array,
  opts?: PdsFetchOpts,
): Promise<any> {
  const url = `${resolveOrigin(opts)}${path}`
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessJwt}`,
  }
  let payload: BodyInit | undefined
  if (body instanceof Uint8Array) {
    headers['content-type'] = opts?.contentType ?? 'application/octet-stream'
    payload = body as BodyInit
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const f = opts?.fetchImpl ?? globalThis.fetch
  const res = await f(url, { method, headers, body: payload })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }

  if (!res.ok) throw new PdsHttpError(res.status, parsed)
  return parsed
}
