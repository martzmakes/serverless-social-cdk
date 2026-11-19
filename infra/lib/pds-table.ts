import { RemovalPolicy } from 'aws-cdk-lib'
import {
  AttributeType,
  BillingMode,
  StreamViewType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

/**
 * Single-table store for the single-tenant PDS repo.
 * Key design (see docs/research/03-serverless-architecture.md §3):
 *   ACCOUNT/ACCOUNT            -> {did, handle, signingKeyId, headCid, rev, status}
 *   SEQ/SEQ                    -> {value:Number}   (atomic ADD => firehose seq)
 *   BLOCK#<cid>/BLOCK          -> {bytes:Binary, rev}
 *   COMMIT#<padSeq>/COMMIT     -> {cid, rev, ts}
 *   RECORD#<collection>/<rkey> -> {cid, rev}
 *   EVT#<padSeq>/EVT           -> {frame:Binary, ttl}   (firehose replay; phase 2)
 */
export class RepoTable extends Construct {
  readonly table: Table
  constructor(scope: Construct, id: string) {
    super(scope, id)
    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      // Phase-2 firehose: stream NEW_IMAGE records so the fanout Lambda
      // (Task 4) can push #commit frames to live WebSocket connections.
      // This is an additive StreamSpecification on the existing table —
      // CloudFormation applies it in-place (no table replacement/data loss).
      stream: StreamViewType.NEW_IMAGE,
    })
  }
}
