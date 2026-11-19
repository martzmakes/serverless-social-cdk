import { ArnFormat, Duration, RemovalPolicy, Stack } from "aws-cdk-lib/core";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, ProjectionType, Table, type ITable } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { IStringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { lambdaSource } from "./lambda-assets";

export interface PostEditorProps {
  api: HttpApi;
  tenants: ITable;
  jwtSecret: IStringParameter;
  environment: Record<string, string>;
}

export class PostEditor extends Construct {
  constructor(scope: Construct, id: string, { api, tenants, jwtSecret, environment }: PostEditorProps) {
    super(scope, id);

    const drafts = new Table(this, "Drafts", {
      partitionKey: { name: "did", type: AttributeType.STRING },
      sortKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    drafts.addGlobalSecondaryIndex({
      indexName: "byShareToken",
      partitionKey: { name: "shareToken", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    const media = new Bucket(this, "Media", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const deadLetter = new Queue(this, "DeadLetter", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    const queue = new Queue(this, "Publications", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: deadLetter, maxReceiveCount: 4 },
    });
    const group = new CfnScheduleGroup(this, "Schedules");
    const stack = Stack.of(this);
    const delivery = new Role(this, "SchedulerDelivery", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": stack.account, "aws:SourceArn": group.attrArn } },
      }),
    });
    queue.grantSendMessages(delivery);
    deadLetter.grantSendMessages(delivery);

    const common = {
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      environment: {
        ...environment,
        TENANTS_TABLE: tenants.tableName,
        DRAFTS_TABLE: drafts.tableName,
        DRAFT_MEDIA_BUCKET: media.bucketName,
        XRPC_ORIGIN: api.apiEndpoint,
      },
    };
    const editor = new NodejsFunction(this, "Api", {
      ...common,
      ...lambdaSource("editor/handler"),
      timeout: Duration.seconds(20),
      environment: {
        ...common.environment,
        SCHEDULE_GROUP: group.ref,
        SCHEDULE_ROLE: delivery.roleArn,
        QUEUE_URL: queue.queueUrl,
        QUEUE_ARN: queue.queueArn,
        DEAD_LETTER_ARN: deadLetter.queueArn,
      },
    });
    const worker = new NodejsFunction(this, "Publish", {
      ...common,
      ...lambdaSource("editor/worker"),
      timeout: Duration.seconds(45),
    });
    for (const handler of [editor, worker]) {
      drafts.grantReadWriteData(handler);
      tenants.grantReadData(handler);
      jwtSecret.grantRead(handler);
    }
    media.grantReadWrite(editor);
    media.grantRead(worker);
    queue.grantSendMessages(editor);
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1, maxConcurrency: 2 }));
    editor.addToRolePolicy(new PolicyStatement({
      actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"],
      resources: [stack.formatArn({ service: "scheduler", resource: "schedule", arnFormat: ArnFormat.SLASH_RESOURCE_NAME, resourceName: `${group.ref}/*` })],
    }));
    editor.addToRolePolicy(new PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [delivery.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
    }));
    for (const path of ["/auth/editor", "/auth/editor/{proxy+}"]) {
      api.addRoutes({
        path,
        methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.DELETE],
        integration: new HttpLambdaIntegration(path.endsWith("}") ? "EditorActions" : "EditorHome", editor),
      });
    }
  }
}
