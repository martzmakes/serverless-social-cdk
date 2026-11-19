import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { Secp256k1Keypair } from '@atproto/crypto'

/** Construct a keypair from a hex-encoded raw secp256k1 private key. */
export async function keypairFromHex(hex: string): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.import(hex)
}

const cache = new Map<string, Secp256k1Keypair>()
const ssm = new SSMClient({})

/** Per-param SSM SecureString load + cache (multi-tenant: one key per tenant). */
export async function getSigningKey(paramName: string): Promise<Secp256k1Keypair> {
  const hit = cache.get(paramName)
  if (hit) return hit
  const res = await ssm.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true }),
  )
  const hex = res.Parameter?.Value
  if (!hex) throw new Error(`signing key SSM param ${paramName} empty`)
  const kp = await keypairFromHex(hex.trim())
  cache.set(paramName, kp)
  return kp
}
