import { RemovalPolicy } from 'aws-cdk-lib'
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

/** Projection of the published longform set. pk='IDX', sk=<rkey>, attr `item` = IndexItem JSON. */
export class LongformIndexTable extends Construct {
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
    })
  }
}
