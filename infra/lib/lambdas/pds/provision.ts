export interface ProvisionPorts {
  getTenantByDomain(domain: string): Promise<any | null>
  mintKeys(): Promise<{ signingHex: string; signingDid: string; rotationHex: string; rotationDid: string }>
  putKey(ref: string, hex: string): Promise<void>
  submitPlc(args: { did: string; signed: any }): Promise<void>
  putTenant(row: any): Promise<void>
  initRepo(did: string): Promise<void>
  verifyHandle(handle: string, did: string): Promise<boolean>
  pokeRelay(handle: string): Promise<void>
  // Phase-D1: auto _atproto TXT management via Route53.
  // publishHandleDns UPSERTS `_atproto.<handle> TXT "did=<did>"` — fail-loud (rejects on error).
  // removeHandleDns DELETEs the same record — Route53 DELETE must match the exact ResourceRecordSet
  // (Name + Type + TTL + ResourceRecords[{Value}]), so the did is required to build the identical
  // record set. Signature includes `did` for this reason; handle-dns.ts DELETE is idempotent
  // (swallows "record does not exist" / InvalidChangeBatch), but callers should still treat it
  // best-effort (a remove failure on suspend should not unwind the already-persisted suspension).
  publishHandleDns(handle: string, did: string): Promise<void>
  removeHandleDns(handle: string, did: string): Promise<void>
}

// ── onActivate / onSuspend lifecycle seam ────────────────────────────────────
// Thin wrappers so the operator script, the live-proof, and tests all share
// one lifecycle definition. onActivate is fail-loud: a sub-user that cannot
// get its _atproto TXT record published is not actually usable on the network.
// onSuspend is best-effort: the suspension has already been persisted in DDB,
// so DNS removal failure is logged by the caller rather than re-thrown here.

export async function onActivate(ports: ProvisionPorts, handle: string, did: string): Promise<void> {
  await ports.publishHandleDns(handle, did)
}

export async function onSuspend(ports: ProvisionPorts, handle: string, did: string): Promise<void> {
  try {
    await ports.removeHandleDns(handle, did)
  } catch (err) {
    // Best-effort: the suspend row is already written to DDB. Log and continue.
    console.warn(`[onSuspend] DNS removal failed for ${handle} (best-effort, non-fatal):`, err)
  }
}
export interface ProvisionInput { email: string; domain: string; pdsEndpoint: string; testHandle?: string }
export interface ProvisionResult { did: string; handle: string; status: 'pending-domain' | 'active' }

// ── Migration path (T3) ──────────────────────────────────────────────────────
// Ports for an account that already has a did:plc and is being moved onto this PDS.
// No genesis op, no rotation-key mint, no initRepo — those are handled externally.
export interface MigratePorts {
  getTenantByDid(did: string): Promise<any | null>
  mintSigningKey(): Promise<{ hex: string }>
  putKey(ref: string, hex: string): Promise<void>
  putTenant(row: any): Promise<void>
}
export interface MigrateInput { did: string; handle: string; domain: string; email: string }
export interface MigrateResult { did: string; status: 'migrating' }

// Ports for transitioning a 'migrating' tenant to 'active' once its repo has been
// imported and its PLC identity repointed at this PDS. Mirrors the get→put idiom
// provisionSubuser uses for its final active write.
export interface ActivateMigratedPorts {
  getTenantByDid(did: string): Promise<any | null>
  putTenant(row: any): Promise<void>
}
export interface ActivateMigratedResult { did: string; status: 'active' }

export async function provisionSubuser(input: ProvisionInput, p: ProvisionPorts): Promise<ProvisionResult> {
  const handle = input.testHandle ?? input.domain

  const existing = await p.getTenantByDomain(input.domain)

  // Fix 3: domain collision — an active tenant already owns this domain.
  // Throw before any minting, regardless of testHandle.
  if (existing && existing.status === 'active' && existing.domain === input.domain) {
    throw new Error(`domain collision: ${input.domain} already owned by ${existing.did}`)
  }

  // Fix 1 / Fix 3 (resume): 'provisioning' or 'pending-domain' rows for this domain are resumable.
  // Reuse the existing did — do NOT mint new keys or submit a new PLC genesis.
  // 'provisioning' means we crashed between putTenant(provisioning) and submitPlc (or between
  // submitPlc and putTenant(pending-domain)). Keys are already persisted; PLC may or may not be
  // submitted. We skip re-submission: if PLC was not submitted the operator re-runs from scratch
  // (suspend tenant row first). The critical safety property is: we NEVER mint a second did:plc.
  let did: string
  let baseRow: Record<string, unknown>

  if (existing && (existing.status === 'provisioning' || existing.status === 'pending-domain')) {
    // RESUME: reuse existing did and all persisted fields
    did = existing.did
    baseRow = existing
  } else {
    // NEW KEY BRANCH
    const k = await p.mintKeys()
    const { tenantKeyRef } = await import('./keymgmt.js')
    const { buildGenesisOp, signGenesisOp, plcDidFromSignedOp } = await import('./plc.js')
    const { Secp256k1Keypair } = await import('@atproto/crypto')
    const rot = await Secp256k1Keypair.import(k.rotationHex)
    const op = buildGenesisOp({
      signingKeyDid: k.signingDid,
      rotationKeyDids: [k.rotationDid],
      handle,
      pdsEndpoint: input.pdsEndpoint,
    })
    const signed = await signGenesisOp(op, rot)
    did = await plcDidFromSignedOp(signed)

    await p.putKey(tenantKeyRef(did, 'signing'), k.signingHex)
    await p.putKey(tenantKeyRef(did, 'rotation'), k.rotationHex)

    baseRow = {
      did, handle, domain: input.domain,
      email: input.email,
      signingKeyRef: tenantKeyRef(did, 'signing'),
      rotationKeyRef: tenantKeyRef(did, 'rotation'),
      createdAt: Date.now(),
    }

    // Fix 1: write transient 'provisioning' row BEFORE submitPlc so a crash here never causes
    // a second DID to be minted on resume — the resume guard above will catch this row.
    await p.putTenant({ ...baseRow, status: 'provisioning' })

    // PLC genesis is idempotent for byte-identical ops — safe to replay on resume.
    await p.submitPlc({ did, signed })

    // Advance status after PLC is durably recorded.
    await p.putTenant({ ...baseRow, status: 'pending-domain' })

    await p.initRepo(did)
  }

  // ── Phase-D / Spec #4 gate-caught Critical: publish BEFORE verify ─────────
  // serverless.social OWNS the serverless.social Route53 zone AND is the PDS.
  // For a *.serverless.social subhandle there is no adversarial "prove you
  // control an external domain" semantics — publishing `_atproto.<handle> TXT
  // "did=<did>"` IS the mechanism by which the handle resolves to the DID.
  // The previous ordering only published in onActivate AFTER status==='active',
  // but verifyHandle gates reaching 'active', so on a first --approve the TXT
  // never existed → verifyHandle false → returned pending-domain → onActivate
  // (publish) skipped → permanently stuck. Unsatisfiable by construction.
  // This mirrors the proven --verify-only remedy (provision-subuser.ts:
  // publishHandleDns THEN verifyHandleControls). publishHandleDns only ever
  // UPSERTs `_atproto.<subhandle>` (idempotent), never the apex / NS / did
  // records — apex did:web:serverless.social stays byte-identical. Covers BOTH
  // the new-key path and the resumed pending-domain path (this runs after the
  // resume/new-key branch has resolved did+handle, before the single verify).
  // The post-active onActivate UPSERT in callers is now a harmless idempotent
  // re-UPSERT (left in place — matches the --verify-only comment's note).
  await p.publishHandleDns(handle, did)

  const ok = await p.verifyHandle(handle, did)
  if (!ok) return { did, handle, status: 'pending-domain' }

  // Fix 2: spread a KNOWN complete row (baseRow from new-key or existing from resume)
  // — never spread a nullable getTenant() re-read.
  await p.putTenant({ ...baseRow, status: 'active' })
  await p.pokeRelay(handle)
  return { did, handle, status: 'active' }
}

// ── migrateExistingDid ───────────────────────────────────────────────────────
// Provisions a row for a did:plc that already exists externally.
// Ordering invariant (same discipline as provisionSubuser):
//   persist signing key to SSM → write tenant row (migrating) → return
// The PLC repoint (pointing the existing DID's atproto-pds service entry at this
// PDS) is an operator-CLI / A3 step done separately — NOT here.
// Resume-safe: a second call with an existing 'migrating' row is a no-op.
export async function migrateExistingDid(input: MigrateInput, p: MigratePorts): Promise<MigrateResult> {
  const { tenantKeyRef } = await import('./keymgmt.js')

  // Resume guard: if a migrating row already exists for this did, reuse it.
  const existing = await p.getTenantByDid(input.did)
  if (existing && existing.status === 'migrating') {
    return { did: input.did, status: 'migrating' }
  }

  // Mint a new serverless.social-held signing key for this DID.
  // putKey uses Overwrite:false so a re-run with a pre-existing key is safe.
  const { hex } = await p.mintSigningKey()
  const signingKeyRef = tenantKeyRef(input.did, 'signing')
  await p.putKey(signingKeyRef, hex)

  // Write the tenant row BEFORE any external/irreversible step (same ordering
  // discipline as provisionSubuser's provisioning-row-before-submitPlc).
  const row = {
    did: input.did,
    handle: input.handle,
    domain: input.domain,
    email: input.email,
    signingKeyRef,
    createdAt: Date.now(),
    status: 'migrating' as const,
  }
  await p.putTenant(row)

  return { did: input.did, status: 'migrating' }
}

// ── activateMigratedTenant ───────────────────────────────────────────────────
// Transitions a 'migrating' tenant row to 'active' so resolveTenant() (tenant.ts)
// will serve the migrated repo. WITHOUT this transition the imported repo is
// present in storage but resolveTenant refuses it (status !== 'active'), so
// com.atproto.sync.getRepo 400s and the account is dead on the network.
//
// This MUST run only AFTER the repo has been imported AND the PLC identity has
// been repointed at serverless.social (the account now expects us to serve it).
//
// Semantics (mirrors provisionSubuser's final active write — spread a KNOWN
// complete row read here, then set status:'active'):
//   - 'migrating'  → flip to 'active' (the normal transition). Row otherwise
//                    byte-unchanged (only `status` differs).
//   - 'active'     → idempotent no-op success (already serving). We still re-put
//                    the unchanged row so a crashed-mid-write prior run converges.
//   - missing      → throw (nothing to activate — caller ordering bug).
//   - 'suspended'  → throw. Never silently un-suspend a deliberately-disabled
//                    tenant (suspension is the teardown/kill switch; reactivation
//                    must be an explicit operator decision, not a side effect).
//   - other status  → throw (unexpected state; refuse rather than guess).
export async function activateMigratedTenant(
  did: string,
  p: ActivateMigratedPorts,
): Promise<ActivateMigratedResult> {
  const row = await p.getTenantByDid(did)
  if (!row) {
    throw new Error(`activateMigratedTenant: no tenant row for ${did} (nothing to activate)`)
  }
  if (row.status === 'active') {
    // Idempotent: already serving. Re-put the KNOWN complete row (status
    // unchanged) so a partially-written prior activation still converges.
    await p.putTenant({ ...row, status: 'active' })
    return { did, status: 'active' }
  }
  if (row.status === 'suspended') {
    throw new Error(
      `activateMigratedTenant: refusing to activate suspended tenant ${did} ` +
      `(suspension is the teardown/kill switch — reactivation must be explicit)`,
    )
  }
  if (row.status !== 'migrating') {
    throw new Error(
      `activateMigratedTenant: tenant ${did} has unexpected status '${row.status}' ` +
      `(expected 'migrating') — refusing to activate`,
    )
  }
  // Spread the KNOWN complete row read above (never a nullable re-read) and flip
  // only `status` — same data-loss-safe idiom as provisionSubuser's active write.
  await p.putTenant({ ...row, status: 'active' })
  return { did, status: 'active' }
}
