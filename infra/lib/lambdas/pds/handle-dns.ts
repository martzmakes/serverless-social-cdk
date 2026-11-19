import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Rr53Action = 'UPSERT' | 'DELETE'

export interface ResourceRecord {
  Value: string
}

export interface ResourceRecordSet {
  Name: string
  Type: 'TXT'
  TTL: number
  ResourceRecords: ResourceRecord[]
}

export interface ChangeBatchEntry {
  Action: Rr53Action
  ResourceRecordSet: ResourceRecordSet
}

export interface ChangeBatch {
  Changes: [ChangeBatchEntry]
}

// ---------------------------------------------------------------------------
// buildAtprotoTxtChange
//
// Pure function — no I/O. Emits a Route53 change-batch for the _atproto TXT
// record used by ATProto handle verification.
//
// Route53 stores TXT values double-quoted; domain-verify.ts parseHandleProof
// receives the value AFTER the HandleResolver has stripped the outer quotes,
// then matches /^did=(.+)$/. The builder MUST emit `"did=<did>"` (with the
// embedded double-quotes) so that when Route53 serves the record and a resolver
// strips those outer quotes, parseHandleProof sees `did=<did>`.
// ---------------------------------------------------------------------------

export function buildAtprotoTxtChange(
  handle: string,
  did: string,
  action: Rr53Action,
): ChangeBatch {
  return {
    Changes: [
      {
        Action: action,
        ResourceRecordSet: {
          Name: `_atproto.${handle}`,
          Type: 'TXT',
          TTL: 300,
          ResourceRecords: [{ Value: `"did=${did}"` }],
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// resolveHostedZoneId
//
// Finds the Route53 hosted zone ID for serverless.social via the AWS CLI.
// Accepts an injectable `exec` for testability (default: execSync).
// Returns the bare zone ID with the leading `/hostedzone/` stripped.
// ---------------------------------------------------------------------------

export function resolveHostedZoneId(
  exec: (cmd: string) => string = (c) => execSync(c, { encoding: 'utf8' }) as string,
): string {
  const raw = exec(
    'aws route53 list-hosted-zones-by-name --dns-name serverless.social --output json',
  )
  const parsed = JSON.parse(raw) as {
    HostedZones: Array<{ Id: string; Name: string }>
  }
  const zone = parsed.HostedZones.find((z) => z.Name === 'serverless.social.')
  if (!zone) {
    throw new Error('serverless.social Route53 hosted zone not found')
  }
  return zone.Id.replace(/^\/hostedzone\//, '')
}

// ---------------------------------------------------------------------------
// applyHandleDnsChange
//
// Applies a Route53 change-batch for a sub-user's _atproto TXT record via the
// AWS CLI (no SDK — mirrors the provision-subuser.ts `aws cloudformation`
// shell-out pattern). Injectable `exec` for testability.
//
// `handle` MUST be a pre-sanitized DNS label produced by deriveHandle() —
// never a raw user string — since it flows into the temp file path. The DNS
// payload itself travels via the JSON file (not the shell command), so the
// shell-injection surface is limited to the AWS-guaranteed zoneId + the temp path.
//
// For DELETE: idempotent — swallows Route53 "record does not exist" signals.
//   - InvalidChangeBatch is the PRIMARY Route53 not-found signal.
//   - "not found" / "does not exist" are defensive AWS-error-message fragments
//     (NOT generic shell errors) included for forward-compatibility.
//   - UPSERT has no such swallow — all UPSERT errors propagate.
// Rethrows anything else (e.g. AccessDenied, network failure).
// ---------------------------------------------------------------------------

export function applyHandleDnsChange(
  handle: string,
  did: string,
  action: Rr53Action,
  exec: (cmd: string) => string = (c) => execSync(c, { encoding: 'utf8' }) as string,
): string {
  const zoneId = resolveHostedZoneId(exec)
  const changeBatch = buildAtprotoTxtChange(handle, did, action)
  const tmp = join(tmpdir(), `atproto-dns-${Date.now()}-${handle}.json`)
  writeFileSync(tmp, JSON.stringify(changeBatch))
  try {
    if (action === 'DELETE') {
      try {
        const raw = exec(
          `aws route53 change-resource-record-sets --hosted-zone-id ${zoneId} --change-batch file://${tmp} --output json`,
        )
        const result = JSON.parse(raw) as { ChangeInfo: { Id: string } }
        return result.ChangeInfo.Id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          msg.includes('InvalidChangeBatch') ||
          msg.toLowerCase().includes('not found') ||
          msg.toLowerCase().includes('does not exist')
        ) {
          return 'deleted-or-absent'
        }
        throw err
      }
    } else {
      const raw = exec(
        `aws route53 change-resource-record-sets --hosted-zone-id ${zoneId} --change-batch file://${tmp} --output json`,
      )
      const result = JSON.parse(raw) as { ChangeInfo: { Id: string } }
      return result.ChangeInfo.Id
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
  }
}
