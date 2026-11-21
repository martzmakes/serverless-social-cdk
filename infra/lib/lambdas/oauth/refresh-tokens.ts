// Refresh-token rotation, extracted from the OAuth handler so the
// concurrency behavior is unit-testable without standing up SSM/SES/etc.
//
// Tokens are opaque random strings; only sha256(token) is persisted (pk
// `REFRESH#<hash>`), so a DDB read never exposes a usable token. Rotation is
// single-use, but MCP connectors fire concurrent / retried token requests
// (observed on macrovault: triplets within the same second, multi-minute
// retry loops). Naive delete-on-use makes the duplicates fail with
// invalid_grant and permanently strands the client — the connector then
// surfaces "Connection has expired. You can reconnect to re-authenticate"
// with no way to silently renew. We instead detect reuse and serve the same
// successor to every refresh inside a short grace window (RFC 6819 §5.2.2.3
// reuse detection), then retire the token.
//
// To keep the "DDB never holds a usable token" property, the successor is
// stored ENCRYPTED under a key derived from the presented (raw) token —
// which the row itself only holds a hash of. Duplicate refresh requests
// carry the raw token and can decrypt; a DB reader cannot.
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "crypto";

// Minimal surface so the real DynamoDBDocumentClient and a test fake both fit.
export interface DocClient {
  send(cmd: unknown): Promise<{ Item?: Record<string, unknown> }>;
}

export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days (idle bound)
// Concurrent/retried refreshes of the same token within this window all get
// the same successor instead of one winner + N stranded losers.
export const REFRESH_REUSE_GRACE_MS = 60_000;

export type RefreshIdentity = {
  email: string;
  clientId: string;
  scope: string;
  resource: string;
};

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newOpaqueToken(): string {
  return base64url(randomBytes(32));
}

// Key derivation for the encrypted successor MUST differ from the pk hash —
// pk = sha256(raw), so deriving the key as sha256(raw) too would let a DB
// reader (who sees the pk) decrypt. A domain-separated prefix keeps the two
// one-way functions independent.
function successorKey(rawToken: string): Buffer {
  return createHash("sha256")
    .update("refresh-successor-enc:" + rawToken)
    .digest();
}

export function encryptSuccessor(rawToken: string, successor: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", successorKey(rawToken), iv);
  const ct = Buffer.concat([cipher.update(successor, "utf8"), cipher.final()]);
  return base64url(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

export function decryptSuccessor(
  rawToken: string,
  blob: string
): string | null {
  try {
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      successorKey(rawToken),
      iv
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    return null;
  }
}

export async function issueRefreshToken(
  ddb: DocClient,
  table: string,
  identity: RefreshIdentity,
  token: string = newOpaqueToken()
): Promise<string> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: `REFRESH#${hashToken(token)}`,
        sk: "REFRESH",
        email: identity.email,
        clientId: identity.clientId,
        scope: identity.scope,
        resource: identity.resource,
        createdAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS,
      },
    })
  );
  return token;
}

// Returns the caller identity plus the successor refresh token the client
// should persist. Null means the token is unusable (unknown/expired/retired).
export async function consumeRefreshToken(
  ddb: DocClient,
  table: string,
  rawToken: string,
  request: { clientId: string; resource: string; scope?: string; allowedEmails: string[] },
): Promise<(RefreshIdentity & { rotatedRefreshToken: string }) | null> {
  const key = { pk: `REFRESH#${hashToken(rawToken)}`, sk: "REFRESH" };
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  const row = res.Item;
  if (!row || row.clientId !== request.clientId || row.resource !== request.resource ||
      typeof row.email !== "string" || !request.allowedEmails.includes(row.email) || typeof row.scope !== "string") return null;
  if (request.scope?.split(" ").some(scope => !String(row.scope).split(" ").includes(scope))) return null;
  const ttl = typeof row.ttl === "number" ? row.ttl : 0;
  if (ttl < Math.floor(Date.now() / 1000)) {
    await ddb.send(new DeleteCommand({ TableName: table, Key: key }));
    return null;
  }
  const identity: RefreshIdentity = {
    email: row.email,
    clientId: request.clientId,
    scope: row.scope,
    resource: request.resource,
  };

  // Already rotated: idempotent inside the grace window (serve the same
  // successor to concurrent/retried requests), retired afterward.
  if (
    typeof row.successorEnc === "string" &&
    typeof row.consumedAt === "number"
  ) {
    if (Date.now() - row.consumedAt < REFRESH_REUSE_GRACE_MS) {
      const successor = decryptSuccessor(rawToken, row.successorEnc);
      return successor ? { ...identity, rotatedRefreshToken: successor } : null;
    }
    return null;
  }

  // First legitimate use. Claim the rotation with a conditional write so only
  // one concurrent caller mints the successor; the row is kept (not deleted)
  // with a short grace ttl so duplicates resolve to the same successor above.
  const successor = newOpaqueToken();
  const nowMs = Date.now();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression:
          "SET consumedAt = :now, successorEnc = :succ, #ttl = :grace",
        ConditionExpression: "attribute_not_exists(consumedAt)",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":now": nowMs,
          ":succ": encryptSuccessor(rawToken, successor),
          ":grace":
            Math.floor(nowMs / 1000) + Math.ceil(REFRESH_REUSE_GRACE_MS / 1000),
        },
      })
    );
  } catch (err) {
    if (
      (err as { name?: string })?.name === "ConditionalCheckFailedException"
    ) {
      // Lost the rotate race — return the winner's successor.
      const re = await ddb.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true })
      );
      const winnerEnc = re.Item?.successorEnc;
      const winner =
        typeof winnerEnc === "string"
          ? decryptSuccessor(rawToken, winnerEnc)
          : null;
      return winner ? { ...identity, rotatedRefreshToken: winner } : null;
    }
    throw err;
  }
  await issueRefreshToken(ddb, table, identity, successor);
  return { ...identity, rotatedRefreshToken: successor };
}
