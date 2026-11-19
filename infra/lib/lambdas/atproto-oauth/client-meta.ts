export interface ClientMetadata {
  client_id: string
  redirect_uris: string[]
  grant_types?: string[]
  scope?: string
  token_endpoint_auth_method?: string
  dpop_bound_access_tokens?: boolean
}

export function validateClientMetadata(doc: any, fetchUrl: string): ClientMetadata {
  if (!doc || typeof doc !== 'object') throw new Error('client-meta: not an object')
  if (doc.client_id !== fetchUrl) throw new Error('client-meta: client_id != document URL')
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) throw new Error('client-meta: redirect_uris required')
  for (const u of doc.redirect_uris) {
    if (typeof u !== 'string' || !u.startsWith('https://')) throw new Error('client-meta: redirect_uris must be https')
  }
  if (doc.dpop_bound_access_tokens !== true) throw new Error('client-meta: dpop_bound_access_tokens required')
  return doc as ClientMetadata
}

export interface LoadOpts {
  fetchImpl?: (url: string, init?: any) => Promise<any>
  maxBytes?: number
  timeoutMs?: number
}

export async function loadClientMetadata(clientId: string, opts: LoadOpts = {}): Promise<ClientMetadata> {
  if (!clientId.startsWith('https://')) throw new Error('client-meta: client_id must be https')
  const f = opts.fetchImpl ?? fetch
  const maxBytes = opts.maxBytes ?? 200_000
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000)
  try {
    const res: any = await f(clientId, { signal: ctrl.signal, redirect: 'error' } as any)
    if (!res.ok) throw new Error(`client-meta: fetch ${res.status}`)
    const text = await res.text()
    if (text.length > maxBytes) throw new Error('client-meta: document size exceeds cap')
    return validateClientMetadata(JSON.parse(text), clientId)
  } finally {
    clearTimeout(t)
  }
}
