import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { verifyJwt } from "./lib/jwt";
import { apexTenant } from "../pds/tenant";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USERS_TABLE = process.env.USERS_TABLE!;

/** Look up a tenant row by email via the byEmail GSI. Returns {did,handle} or null. */
async function resolveTenantIdentity(
  email: string
): Promise<{ did: string; handle: string } | null> {
  const adminEmail = process.env.ADMIN_EMAIL ?? "";
  const tenantsTable = process.env.TENANTS_TABLE;
  // Admin/apex path — no DDB query needed.
  if (email === adminEmail) {
    const apex = apexTenant();
    return { did: apex.did, handle: apex.handle };
  }
  if (!tenantsTable) return null;
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tenantsTable,
        IndexName: "byEmail",
        KeyConditionExpression: "email = :e",
        ExpressionAttributeValues: { ":e": email },
        Limit: 1,
      })
    );
    const item = res.Items?.[0];
    if (!item) return null;
    return { did: item.did as string, handle: item.handle as string };
  } catch (err) {
    console.error('[me] resolveTenantIdentity TenantsTable lookup failed', err)
    return null;
  }
}

function response(statusCode: number, body?: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,DELETE,OPTIONS",
    },
    body: body ? JSON.stringify(body) : "",
  };
}

async function extractEmail(
  authHeader: string | undefined
): Promise<string | null> {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  try {
    const { email } = await verifyJwt(match[1]);
    return email;
  } catch {
    return null;
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return response(204);

  const authHeader =
    event.headers?.authorization || event.headers?.Authorization;
  const email = await extractEmail(authHeader);
  if (!email) return response(401, { error: "unauthorized" });

  if (method === "GET") {
    const [user, identity] = await Promise.all([
      ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } })),
      resolveTenantIdentity(email),
    ]);
    if (!user.Item) {
      // User row was deleted — re-seed so the JWT stays usable until expiry.
      const now = Date.now();
      await ddb.send(
        new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { email },
          UpdateExpression:
            "SET lastLoginAt = :now, createdAt = if_not_exists(createdAt, :now), ownedEntitlements = if_not_exists(ownedEntitlements, :empty)",
          ExpressionAttributeValues: {
            ":now": now,
            ":empty": [] as string[],
          },
        })
      );
      return response(200, {
        email,
        ownedEntitlements: [],
        createdAt: now,
        lastLoginAt: now,
        did: identity?.did ?? null,
        handle: identity?.handle ?? null,
      });
    }
    return response(200, {
      email: user.Item.email,
      ownedEntitlements: user.Item.ownedEntitlements || [],
      createdAt: user.Item.createdAt || null,
      lastLoginAt: user.Item.lastLoginAt || null,
      did: identity?.did ?? null,
      handle: identity?.handle ?? null,
    });
  }

  if (method === "DELETE") {
    await ddb.send(
      new DeleteCommand({ TableName: USERS_TABLE, Key: { email } })
    );
    return response(204);
  }

  return response(405, { error: "method_not_allowed" });
};
