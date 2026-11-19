// Single-tenant identity. Handle == apex domain.
// Override by setting PDS_HANDLE in the Lambda environment (threaded from
// CDK context `pdsHandle`). Defaults to 'serverless.social' so the live
// instance requires zero env-var changes.
export const HANDLE: string = process.env.PDS_HANDLE ?? 'serverless.social'
export const DID: string = `did:web:${HANDLE}` // did:web:serverless.social (or override)
export const PDS_ENDPOINT: string = `https://${HANDLE}`

// Env var names (set on the Lambda by CDK in Task 9)
export const ENV = {
  REPO_TABLE: 'REPO_TABLE',
  SIGNING_KEY_PARAM: 'SIGNING_KEY_PARAM', // SSM SecureString name
  JWT_SECRET_PARAM: 'JWT_SECRET_PARAM',
  TENANTS_TABLE: 'TENANTS_TABLE',
} as const

export const SIGNING_KEY_SSM = process.env.SIGNING_KEY_PARAM ?? `/${process.env.PROJECT_SLUG ?? "serverless-social"}/atproto-signing-key`
