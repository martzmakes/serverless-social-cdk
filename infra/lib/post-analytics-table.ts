import { RemovalPolicy } from 'aws-cdk-lib'
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

/**
 * Post analytics rollup (Spec #8 / Phase E).
 *
 * pk = VIEW#<host>#<slug>      / sk = <yyyy-mm-dd>            → per-slug/day rollup
 *                                                       (views, bot counts, attribution)
 * pk = VIEW#<host>#<slug>      / sk = REF#<yyyy-mm-dd>#<host> → per-host referrer
 *                                                       count (human-only)
 * pk = CLAIM#<s3key>    / sk = LOG                     → at-least-once claim
 *                                                       latch (TTL-expired
 *                                                       via `ttl`)
 * pk = PROCESSED#<s3key>/ sk = LOG                     → DONE marker, written
 *                                                       last on full success
 *                                                       (TTL-expired via `ttl`)
 * pk = ENGAGE#<postUri> / sk = <yyyy-mm-dd>            → AppView engagement
 *                                                       snapshot (likes/
 *                                                       reposts/replies/slug)
 *
 * Durable read-side analytics — PAY_PER_REQUEST (scale-to-zero), PITR, RETAIN
 * so a redeploy/teardown never silently drops the rollup history. TTL attribute
 * `ttl` lets the idempotency markers self-expire.
 */
export class PostAnalyticsTable extends Construct {
  readonly table: Table
  constructor(scope: Construct, id: string) {
    super(scope, id)
    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    })
  }
}
