import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const { rows, ddb } = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), ddb: vi.fn() }));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class { async send() { return { Parameter: { Value: "synthetic-signing-key-for-mcp-test-only" } }; } },
  GetParameterCommand: class {},
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: ddb }) },
}));
vi.mock("../lib/lambdas/auth/lib/email", () => ({ sendMagicLinkEmail: vi.fn() }));

const origin = "https://serverless.example";
const resource = origin + "/mcp";
const account = "owner@example.com";
const redirect = "http://127.0.0.1:12345/callback";
const verifier = "syntheticPkceVerifier01234567890123456789012";
const challenge = createHash("sha256").update(verifier).digest("base64url");
let oauth: typeof import("../lib/lambdas/oauth/handler").handler;
let mcp: typeof import("../lib/lambdas/mcp/server").handler;
let mintJwt: typeof import("../lib/lambdas/auth/lib/jwt").mintJwt;
let verifyJwt: typeof import("../lib/lambdas/auth/lib/jwt").verifyJwt;

beforeAll(async () => {
  vi.stubEnv("DOMAIN", "serverless.example");
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("PROJECT_SLUG", "test-social");
  vi.stubEnv("ALLOWED_EMAILS", account);
  vi.stubEnv("OAUTH_TABLE", "oauth-test");
  ({ handler: oauth } = await import("../lib/lambdas/oauth/handler"));
  ({ handler: mcp } = await import("../lib/lambdas/mcp/server"));
  ({ mintJwt, verifyJwt } = await import("../lib/lambdas/auth/lib/jwt"));
});

beforeEach(() => {
  rows.clear();
  ddb.mockReset().mockImplementation(async command => {
    const { Key, Item, ConditionExpression, ExpressionAttributeValues: values } = command.input;
    const key = Key?.pk ?? Item?.pk;
    const current = rows.get(key);
    const fail = () => { throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }); };
    if (command.constructor.name === "GetCommand") return { Item: current ? { ...current } : undefined };
    if (command.constructor.name === "PutCommand") {
      if (ConditionExpression && (!current || current.consentToken !== values[":consent"] || current.approved !== false)) fail();
      rows.set(key, { ...Item });
    } else if (command.constructor.name === "DeleteCommand") {
      if (ConditionExpression && (!current || current.approved !== true || current.email !== values[":email"])) fail();
      rows.delete(key);
    } else if (command.constructor.name === "UpdateCommand") {
      if (!current || current.consumedAt) fail();
      Object.assign(current!, { consumedAt: values[":now"], successorEnc: values[":succ"], ttl: values[":grace"] });
    } else {
      throw new Error("Unexpected DynamoDB command: " + command.constructor.name);
    }
    return {};
  });
});

const event = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => ({
  rawPath: path, requestContext: { http: { method } },
  headers: { "content-type": "application/json", ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}) as APIGatewayProxyEventV2;

async function run(handler: typeof oauth, req: APIGatewayProxyEventV2) {
  return await handler(req, {} as never, () => {}) as APIGatewayProxyStructuredResultV2;
}

const json = (result: APIGatewayProxyStructuredResultV2) => JSON.parse(result.body ?? "{}");

async function authorize(scope?: string) {
  const registration = await run(oauth, event("POST", "/oauth/register", {}, { redirect_uris: [redirect], client_name: "MCP Test" }));
  expect(registration.statusCode).toBe(201);
  const clientId = json(registration).client_id;
  const cookie = "test-social_sso=" + await mintJwt(account);
  const authorizeRequest = {
    ...event("GET", "/oauth/authorize"), cookies: [cookie],
    queryStringParameters: {
      client_id: clientId, redirect_uri: redirect, response_type: "code", resource,
      code_challenge_method: "S256", code_challenge: challenge, state: "client-state",
      ...(scope ? { scope } : {}),
    },
  };
  const consent = await run(oauth, authorizeRequest);
  expect(consent.statusCode).toBe(200);
  const code = /name="auth_code" value="([^"]+)"/.exec(consent.body!)![1];
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(consent.body!)![1];
  const callback = await run(oauth, {
    ...event("POST", "/oauth/consent", { "content-type": "application/x-www-form-urlencoded" }),
    cookies: [cookie],
    body: new URLSearchParams({ auth_code: code, consent_token: consentToken, decision: "allow" }).toString(),
  });
  expect(callback.statusCode).toBe(302);
  const destination = new URL(String(callback.headers?.location));
  expect(destination.searchParams.get("iss")).toBe(resource);
  expect(destination.searchParams.get("state")).toBe("client-state");
  return { code, client_id: clientId, redirect_uri: redirect, resource, code_verifier: verifier, grant_type: "authorization_code" };
}

const token = (body: unknown) => run(oauth, event("POST", "/oauth/token", {}, body));
const rpc = (bearer: string, method: string, params?: unknown, extra: Record<string, string> = {}) =>
  run(mcp, event("POST", "/mcp", { authorization: "Bearer " + bearer, ...extra }, { jsonrpc: "2.0", id: 1, method, params }));

describe("MCP OAuth and transport", () => {
  it("issues a read-only MCP token and keeps browser and MCP sessions separate", async () => {
    const authorization = await authorize();
    const web = await mintJwt(account);
    expect((await rpc(web, "tools/list")).statusCode).toBe(401);
    const grant = await token(authorization);
    expect(grant.statusCode).toBe(200);
    const access = json(grant).access_token;
    expect(json(grant)).toMatchObject({ expires_in: 3600, scope: "mcp:read" });
    await expect(verifyJwt(access)).rejects.toThrow();
    const catalog = await rpc(access, "tools/list");
    expect(json(catalog).result.tools.map((tool: { name: string }) => tool.name)).toContain("get_page_views");
    expect(json(catalog).result.tools.map((tool: { name: string }) => tool.name)).not.toContain("create_post");
    const rejected = await rpc(access, "tools/call", { name: "create_post" });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers?.["www-authenticate"]).toContain('error="insufficient_scope"');
    expect((await rpc(access, "tools/list", {}, { origin: "https://other.example" })).statusCode).toBe(403);
  });

  it("advertises canonical PKCE discovery and serves legacy Streamable HTTP without session state", async () => {
    const discovery = await run(oauth, event("GET", "/.well-known/oauth-protected-resource/mcp"));
    expect(json(discovery)).toMatchObject({ resource, authorization_servers: [resource] });
    const issuer = await run(oauth, event("GET", "/.well-known/oauth-authorization-server/mcp"));
    expect(json(issuer)).toMatchObject({
      issuer: resource, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
    });
    const access = json(await token(await authorize())).access_token;
    const result = await rpc(access, "initialize", { protocolVersion: "2025-11-25" });
    expect(json(result).result.protocolVersion).toBe("2025-11-25");
    expect(result.headers?.["mcp-session-id"]).toBeUndefined();
    expect((await rpc(access, "tools/list", {}, { "mcp-protocol-version": "2026-07-28" })).statusCode).toBe(400);
    const notification = await run(mcp, event("POST", "/mcp", { authorization: "Bearer " + access }, {
      jsonrpc: "2.0", method: "tools/call", params: { name: "delete_record" },
    }));
    expect(notification.statusCode).toBe(202);
    const blocked = await run(mcp, event("OPTIONS", "/mcp", { origin: "https://other.example" }));
    expect(blocked.statusCode).toBe(403);
    const allowed = await run(mcp, event("OPTIONS", "/mcp", { origin }));
    expect(allowed.headers?.["access-control-allow-origin"]).toBe(origin);
  });

  it("binds codes to resource, client, PKCE, and exact callback and redeems them once", async () => {
    const grant = await authorize("mcp:read mcp:tools");
    expect(json(await token({ ...grant, resource: origin + "/oauth" })).error).toBe("invalid_target");
    expect(json(await token({ ...grant, redirect_uri: "http://127.0.0.1:54321/callback" })).error).toBe("invalid_grant");
    expect(json(await token({ ...grant, client_id: "another-client" })).error).toBe("invalid_grant");
    expect(json(await token({ ...grant, code_verifier: "b".repeat(43) })).error).toBe("invalid_grant");
    const responses = await Promise.all([token(grant), token(grant)]);
    expect(responses.map(value => value.statusCode).sort()).toEqual([200, 400]);
    const access = json(responses.find(value => value.statusCode === 200)!).access_token;
    const catalog = await rpc(access, "tools/list");
    expect(json(catalog).result.tools).toContainEqual(expect.objectContaining({
      name: "delete_record", annotations: expect.objectContaining({ destructiveHint: true, readOnlyHint: false }),
    }));
  });

  it("keeps invalid client refreshes from consuming the grant and never expands a narrowed access token", async () => {
    const authorization = await authorize("mcp:read mcp:tools");
    const grant = json(await token(authorization));
    const request = { grant_type: "refresh_token", resource, refresh_token: grant.refresh_token, client_id: authorization.client_id };
    expect((await token({ ...request, client_id: "another-client" })).statusCode).toBe(400);
    expect((await token({ ...request, resource: "https://other.example/mcp" })).statusCode).toBe(400);
    const refresh = await token({ ...request, scope: "mcp:read" });
    expect(refresh.statusCode).toBe(200);
    expect(json(refresh).scope).toBe("mcp:read");
    expect((await rpc(json(refresh).access_token, "tools/call", { name: "delete_record" })).statusCode).toBe(403);
    const retry = await token(request);
    expect(json(retry).refresh_token).toBe(json(refresh).refresh_token);
  });
});
