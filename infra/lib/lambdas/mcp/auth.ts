import { SignJWT, jwtVerify } from "jose";
import { loadAppJwtKey } from "../auth/lib/jwt";

export const READ_SCOPE = "mcp:read";
export const WRITE_SCOPE = "mcp:tools";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const MCP_SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;

export function mcpResource(baseUrl: string) {
  return new URL("/mcp", baseUrl).href;
}

export function normalizeMcpScope(scope: string | undefined) {
  if (scope === undefined) return READ_SCOPE;
  const requested = new Set(scope.split(" "));
  if (requested.size === 0 || [...requested].some(value => !MCP_SCOPES.some(known => known === value))) return;
  return MCP_SCOPES.filter(value => requested.has(value)).join(" ");
}

export async function mintMcpToken(email: string, scope: string, resource: string) {
  const key = await loadAppJwtKey();
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setSubject(email)
    .setIssuer(resource)
    .setAudience(resource)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key);
}

export async function verifyMcpToken(token: string, resource: string) {
  const { payload } = await jwtVerify(token, await loadAppJwtKey(), {
    issuer: resource,
    audience: resource,
    algorithms: ["HS256"],
    typ: "at+jwt",
    requiredClaims: ["sub", "iat", "exp"],
    maxTokenAge: ACCESS_TOKEN_TTL_SECONDS,
  });
  const scope = typeof payload.scope === "string" ? normalizeMcpScope(payload.scope) : undefined;
  if (!payload.sub || !scope || payload.aud !== resource) throw new Error("Invalid MCP token claims");
  return { email: payload.sub, scopes: scope.split(" ") };
}

export function oauthResourceMatches(presented: string | undefined, resource: string) {
  // Older clients sometimes omit resource. This issuer serves exactly one
  // resource, with its own canonical audience even on that compatibility path.
  return presented === undefined || presented === resource;
}
