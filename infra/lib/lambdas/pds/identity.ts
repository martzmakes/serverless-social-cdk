import { DID, HANDLE, PDS_ENDPOINT } from './lexicons'
import { type Tenant, apexTenant } from './tenant'

// ---------------------------------------------------------------------------
// Tenant-parameterized variants
// ---------------------------------------------------------------------------

/** did:web document. signingDidKey = keypair.did() (a did:key:zQ3s...).
 *  NOTE: only meaningful for did:web (apex). plc tenants have their DID doc
 *  in plc.directory — we do NOT fabricate one for them. */
export function didDocumentFor(t: Tenant, signingDidKey: string) {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/secp256k1-2019/v1',
    ],
    id: t.did,
    alsoKnownAs: [`at://${t.handle}`],
    verificationMethod: [
      {
        id: `${t.did}#atproto`,
        type: 'Multikey',
        controller: t.did,
        publicKeyMultibase: signingDidKey.replace('did:key:', ''),
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: t.pdsEndpoint,
      },
    ],
  }
}

export function describeServerFor(t: Tenant) {
  return {
    did: t.did,
    availableUserDomains: [`.${t.handle}`],
    inviteCodeRequired: false,
    links: {},
  }
}

export function resolveHandleFor(t: Tenant, handle: string): string {
  if (handle !== t.handle) {
    const e: any = new Error(`Unable to resolve handle: ${handle}`)
    e.xrpcError = 'InvalidRequest'
    throw e
  }
  return t.did
}

// ---------------------------------------------------------------------------
// Apex-preserving wrappers (byte-identical to original exports)
// ---------------------------------------------------------------------------

/** did:web document. signingDidKey = keypair.did() (a did:key:zQ3s...). */
export function didDocument(signingDidKey: string) {
  return didDocumentFor(apexTenant(), signingDidKey)
}

export function describeServer() {
  return describeServerFor(apexTenant())
}

export function resolveHandle(handle: string): string {
  return resolveHandleFor(apexTenant(), handle)
}
