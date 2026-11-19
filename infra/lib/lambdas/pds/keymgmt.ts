import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm'
import { Secp256k1Keypair } from '@atproto/crypto'

const ssm = new SSMClient({})

// SSM parameter paths allow only letters, numbers, .-_ and / separators.
// DIDs contain colons (e.g. did:plc:abc123) which are not valid.
// We encode the DID by replacing colons with underscores for the path segment.
const encodeDid = (did: string) => did.replace(/:/g, '_')

export const tenantKeyRef = (did: string, role: 'signing' | 'rotation') =>
  `/${process.env.PROJECT_SLUG ?? "serverless-social"}/tenants/${encodeDid(did)}/${role}`

export async function mintSecp256k1(): Promise<{ keypair: Secp256k1Keypair; hex: string }> {
  const kp = await Secp256k1Keypair.create({ exportable: true })
  const exported = await kp.export()
  const hex = Buffer.from(exported).toString('hex')
  return { keypair: kp, hex }
}

export async function putKey(ref: string, hex: string): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: ref, Value: hex, Type: 'SecureString', Overwrite: false }))
}
export async function getKeyHex(ref: string): Promise<string> {
  const r = await ssm.send(new GetParameterCommand({ Name: ref, WithDecryption: true }))
  if (!r.Parameter?.Value) throw new Error(`key ref ${ref} empty`)
  return r.Parameter.Value.trim()
}
