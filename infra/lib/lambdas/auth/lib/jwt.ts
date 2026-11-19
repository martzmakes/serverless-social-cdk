import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SignJWT, jwtVerify } from "jose";

const ssm = new SSMClient({});
const SECRET_NAME = process.env.JWT_SECRET_NAME!;
const ISSUER = process.env.DOMAIN!;
const AUDIENCE = `${process.env.PROJECT_SLUG!}_app`;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let cachedKey: Uint8Array | null = null;

export async function loadAppJwtKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  const res = await ssm.send(
    new GetParameterCommand({ Name: SECRET_NAME, WithDecryption: true })
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error("JWT secret not found in SSM");
  cachedKey = new TextEncoder().encode(value);
  return cachedKey;
}

export async function mintJwt(email: string): Promise<string> {
  const key = await loadAppJwtKey();
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + TTL_SECONDS)
    .sign(key);
}

export async function verifyJwt(token: string): Promise<{ email: string }> {
  const key = await loadAppJwtKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("JWT missing subject");
  }
  return { email: payload.sub };
}
