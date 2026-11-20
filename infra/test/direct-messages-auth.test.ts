import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { SignJWT } from "jose";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const project = "dm-fixture";
  const apex = "publisher.example";
  const tenant = "writer.example";
  const tenantDid = "did:plc:xxxxxxxxxxxxxxxxxxxxxxxx";
  const email = "owner@example.com";
  const jwtSecret = "a test-only secret for direct message authorization";
  const jwtParameter = `/${project}/jwt-secret`;
  const apexSigning = `/${project}/atproto-signing-key`;
  const tenantSigning = `/${project}/tenants/${tenantDid.replace(/:/g, "_")}/signing`;
  const row = { did: tenantDid, handle: tenant, email, status: "active", signingKeyRef: tenantSigning };
  const table = "fixture-tenants";
  for (const [name, value] of Object.entries({
    PROJECT_SLUG: project, DOMAIN: apex, PDS_HANDLE: apex, KNOWN_TENANT_HOSTS: tenant,
    ALLOWED_EMAILS: email, TENANTS_TABLE: table, JWT_SECRET_NAME: jwtParameter, SIGNING_KEY_PARAM: apexSigning,
  })) vi.stubEnv(name, value);
  const query = vi.fn();
  const ssm = vi.fn(({ input }: { input: { Name: string } }) => {
    if (input.Name === jwtParameter) return Promise.resolve({ Parameter: { Value: jwtSecret } });
    if (input.Name === apexSigning || input.Name === tenantSigning) {
      return Promise.resolve({ Parameter: { Value: "a".repeat(64) } });
    }
    throw new Error("Unexpected fixture parameter");
  });
  return { project, apex, tenant, tenantDid, email, jwtSecret, row, table, query, ssm };
});

vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...(await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>()),
  DynamoDBDocumentClient: { from: () => ({ send: fixture.query }) },
}));

vi.mock("@aws-sdk/client-ssm", async importOriginal => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-ssm")>()),
  SSMClient: class { send = fixture.ssm; },
}));

import { handler } from "../lib/lambdas/chat/handler";

async function listEvent(host: string, claim?: string, options?: { expired?: boolean; otherAudience?: boolean }) {
  const token = await new SignJWT(claim === undefined ? {} : { siteHost: claim })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(fixture.email)
    .setIssuer(fixture.apex)
    .setAudience(options?.otherAudience ? `did:web:${fixture.apex}` : `${fixture.project}_app`)
    .setExpirationTime(options?.expired ? 0 : "2 minutes")
    .sign(new TextEncoder().encode(fixture.jwtSecret));
  return {
    rawPath: "/auth/messages",
    requestContext: { http: { method: "GET" } },
    headers: { authorization: `Bearer ${token}`, "x-pds-viewer-host": host },
  } as unknown as APIGatewayProxyEventV2;
}

afterEach(() => {
  fixture.query.mockReset();
  vi.unstubAllGlobals();
});
afterAll(() => vi.unstubAllEnvs());

describe("production DM handler authorization", () => {
  it("binds each magic-link session to a different signed actor even for the same owner", async () => {
    fixture.query.mockImplementation(({ input }) => Promise.resolve(
      input.IndexName === "byEmail" ? { Items: [fixture.row] } : { Item: fixture.row },
    ));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ convos: [] }));
    vi.stubGlobal("fetch", fetcher);
    const apex = await handler(await listEvent(fixture.apex, fixture.apex));
    const tenant = await handler(await listEvent(fixture.tenant, fixture.tenant));
    expect(apex.statusCode).toBe(200);
    expect(tenant.statusCode).toBe(200);
    expect(JSON.parse(apex.body).actor.did).toBe(`did:web:${fixture.apex}`);
    expect(JSON.parse(tenant.body).actor.did).toBe(fixture.tenantDid);
    expect(fetcher.mock.calls.map(([, init]) => {
      const token = new Headers(init?.headers).get("authorization")!;
      return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).iss;
    })).toEqual([`did:web:${fixture.apex}`, fixture.tenantDid]);
    expect(fixture.query).toHaveBeenCalledWith(expect.objectContaining({ input: {
      TableName: fixture.table, Key: { did: fixture.tenantDid }, ConsistentRead: true,
    } }));
  });

  it("rejects a different viewer host, OAuth SSO, XRPC audience, or an expired JWT before contacting AWS storage", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const results = await Promise.all([
      listEvent(fixture.tenant, fixture.apex).then(handler),
      listEvent(fixture.tenant).then(handler),
      listEvent(fixture.tenant, fixture.tenant, { otherAudience: true }).then(handler),
      listEvent(fixture.tenant, fixture.tenant, { expired: true }).then(handler),
    ]);
    expect(results.map(result => result.statusCode)).toEqual([403, 403, 401, 401]);
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed after a tenant transfer, suspension, or signing-key mismatch despite a stale entitlement", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    for (const current of [
      { ...fixture.row, email: "new-owner@example.com" },
      { ...fixture.row, status: "suspended" },
      { ...fixture.row, signingKeyRef: "/different-actor/signing" },
    ]) {
      fixture.query.mockResolvedValueOnce({ Items: [fixture.row] }).mockResolvedValueOnce({ Item: current });
      const result = await handler(await listEvent(fixture.tenant, fixture.tenant));
      expect(result).toMatchObject({ statusCode: 403, body: expect.stringContaining("site_identity_required") });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
