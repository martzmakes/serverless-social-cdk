import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm'

// ---------------------------------------------------------------------------
// SSM path helpers
// ---------------------------------------------------------------------------

// SSM parameter paths allow only letters, numbers, .-_ and / separators.
// Handles are typically DNS names (letters, digits, dots, hyphens) and are
// already SSM-safe, but we apply the same `:` → `_` defensive encoding
// used by the AT secp256k1 key namespace for consistency.
const encode = (handle: string) => handle.replace(/:/g, '_')

/**
 * Returns the SSM parameter name for an actor's AP RSA key.
 * This is a SEPARATE namespace from the AT secp256k1 signing keys
 * (/serverless-social/tenants/*). Compromise of an AP RSA key must not
 * be able to forge AT commits.
 */
export const apKeyRef = (handle: string): string =>
  `/${process.env.PROJECT_SLUG ?? "serverless-social"}/ap/${encode(handle)}/rsa`

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Derives the SPKI-format public PEM from a PKCS#8 private PEM.
 * No new dependencies — uses Node built-in `node:crypto`.
 */
export function derivePublicPem(privatePem: string): string {
  return createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }) as string
}

// ---------------------------------------------------------------------------
// Module-level cache (mirrors signing-key.ts pattern)
// ---------------------------------------------------------------------------

const cache = new Map<string, { privatePem: string; publicPem: string }>()

// ---------------------------------------------------------------------------
// Mint / load
// ---------------------------------------------------------------------------

/**
 * Retrieves the AP RSA keypair for the given SSM ref, or mints a new one.
 *
 * Flow:
 *   1. Check module-level cache.
 *   2. GetParameter (WithDecryption) — cache + return on hit.
 *   3. On miss: generate RSA-2048 + PutParameter(SecureString, Overwrite:false).
 *      If PutParameter throws ParameterAlreadyExists (concurrent mint won),
 *      re-Get and use the winner's value.
 *   4. Cache + return.
 *
 * `ssm` is injected so tests can provide a mock without module-singleton issues.
 */
export async function getOrMintApKey(
  ref: string,
  ssm: SSMClient,
): Promise<{ privatePem: string; publicPem: string }> {
  // 1. Module-level cache hit
  const hit = cache.get(ref)
  if (hit) return hit

  // 2. Try to load from SSM
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: ref, WithDecryption: true }))
    const privatePem = res.Parameter?.Value
    if (!privatePem) throw new Error(`AP key SSM param ${ref} is empty`)
    const kp = { privatePem: privatePem.trim(), publicPem: derivePublicPem(privatePem.trim()) }
    cache.set(ref, kp)
    return kp
  } catch (err: unknown) {
    const name = (err as { name?: string }).name
    if (name !== 'ParameterNotFound') throw err
    // Parameter doesn't exist yet — mint a new one
  }

  // 3. Mint RSA-2048
  const { privateKey: privatePem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  // 4. PutParameter with Overwrite:false — prevents concurrent mints from clobbering
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: ref,
        Value: privatePem.trim(),
        Type: 'SecureString',
        Overwrite: false,
      }),
    )
  } catch (err: unknown) {
    const name = (err as { name?: string }).name
    if (name !== 'ParameterAlreadyExists') throw err
    // Concurrent mint won the race — re-Get the winner's value
    const res = await ssm.send(new GetParameterCommand({ Name: ref, WithDecryption: true }))
    const existing = res.Parameter?.Value
    if (!existing) throw new Error(`AP key SSM param ${ref} empty after race re-Get`)
    const kp = { privatePem: existing.trim(), publicPem: derivePublicPem(existing.trim()) }
    cache.set(ref, kp)
    return kp
  }

  // 5. PutParameter succeeded — use our freshly minted key
  const kp = { privatePem: privatePem.trim(), publicPem: derivePublicPem(privatePem.trim()) }
  cache.set(ref, kp)
  return kp
}
