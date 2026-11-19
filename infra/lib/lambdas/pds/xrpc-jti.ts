import { PutCommand } from '@aws-sdk/lib-dynamodb'

/**
 * xrpc DPoP jti-replay guard (D2).
 *
 * This MUST mirror the OAuth token endpoint's replay guard EXACTLY so the
 * xrpc layer and the token endpoint share ONE logical jti namespace/semantics:
 *
 *   SOURCE OF TRUTH: infra/lib/lambdas/atproto-oauth/store.ts:69-81
 *     (OAuthStore.seenJti) — conditional PutCommand on the same OAuth table:
 *       Item: { pk: `JTI#${jti}`, sk: 'JTI', ttl: floor(Date.now()/1000)+sec }
 *       ConditionExpression: 'attribute_not_exists(pk)'
 *       → returns false on first sighting, true on ConditionalCheckFailed
 *         (already seen / replay).
 *
 *   TTL: the OAuth token endpoint calls `store.seenJti(j, 300)`
 *     (atproto-oauth/handler.ts:254), which matches dpop.ts's
 *     `maxSkewSec ?? 300` default (atproto-oauth/dpop.ts:21). We use the same
 *     300s here so a jti can never outlive the window in which a proof with
 *     that jti would still be accepted.
 *
 *   Boolean sense (verify against atproto-oauth/dpop.ts:25):
 *     `if (await c.seenJti(payload.jti)) throw new Error('dpop: jti replay')`
 *     → TRUE means "already seen → replay", FALSE means "newly recorded".
 *
 * Neither the OAuth table name nor the TTL constant is exported from the
 * oauth store, so the contract is replicated here verbatim with this
 * cross-reference comment. If store.ts changes its JTI key/ttl contract,
 * this MUST change in lockstep.
 */

const JTI_TTL_SEC = 300 // mirrors atproto-oauth/handler.ts:254 store.seenJti(j, 300)

// mirrors `ttl` in atproto-oauth/store.ts:3
const ttl = (sec: number) => Math.floor(Date.now() / 1000) + sec

function isConditionalCheckFailed(err: any): boolean {
  return err?.name === 'ConditionalCheckFailedException'
}

/**
 * Build the `seenJti` port wired into verifyXrpcAuth.
 * @param doc  the existing @aws-sdk/lib-dynamodb DocumentClient (no new dep)
 * @param tableName  the OAuth replay-guard table (same physical table as the
 *                   token endpoint's OAuthStore — shared jti namespace)
 * @returns (jti) => Promise<boolean>: false=first sighting, true=replay
 */
export function makeXrpcSeenJti(
  doc: { send: (cmd: any) => Promise<any> },
  tableName: string,
): (jti: string) => Promise<boolean> {
  return async (jti: string): Promise<boolean> => {
    try {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: `JTI#${jti}`, sk: 'JTI', ttl: ttl(JTI_TTL_SEC) },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      return false // first sighting
    } catch (err: any) {
      if (isConditionalCheckFailed(err)) return true // already seen → replay
      throw err
    }
  }
}
