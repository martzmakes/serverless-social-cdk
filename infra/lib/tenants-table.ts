import { RemovalPolicy } from 'aws-cdk-lib'
import { AttributeType, BillingMode, ProjectionType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

/** Sub-user tenant registry. pk=did; GSIs byHandle, byDomain. Apex needs no row. */
export class TenantsTable extends Construct {
  readonly table: Table
  constructor(scope: Construct, id: string) {
    super(scope, id)
    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'did', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    })
    this.table.addGlobalSecondaryIndex({
      indexName: 'byHandle',
      partitionKey: { name: 'handle', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    })
    this.table.addGlobalSecondaryIndex({
      indexName: 'byDomain',
      partitionKey: { name: 'domain', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    })
    this.table.addGlobalSecondaryIndex({
      indexName: 'byEmail',
      partitionKey: { name: 'email', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    })
  }
}
