import { Construct } from 'constructs'
import * as cdk from 'aws-cdk-lib/core'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as s3assets from 'aws-cdk-lib/aws-s3-assets'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FirehoseBoxInstanceConfig {
  /** Short unique id for this PDS instance (e.g. 'serverless.social'). */
  readonly instanceId: string
  /** The DynamoDB RepoTable backing this PDS instance. */
  readonly repoTable: dynamodb.ITable
  /** AT Protocol DID for this instance (e.g. 'did:web:serverless.social'). */
  readonly did: string
  /**
   * Value of the X-PDS-Instance header this instance accepts.
   * Typically the domain, e.g. 'serverless.social'.
   */
  readonly originHeader: string
  /**
   * Full list of AT Protocol DIDs served by this instance (apex DID + any
   * sub-user DIDs).  Defaults to `[did]` when omitted.
   *
   * Sub-users share the SAME RepoTable under `<did>#`-prefixed keys (Approach B).
   * Adding DIDs here is purely additive — no new table or IAM grant is required.
   * The firehose box streams ALL EVT# rows from the shared RepoTable regardless
   * of which DID produced them; per-DID frames are emitted from the row payload.
   * This field is advertised in the SSM registry so relays/AppViews can discover
   * the full set of DIDs for this instance.
   */
  readonly dids?: string[]
}

export interface FirehoseBoxProps {
  /** List of PDS instances this firehose box serves. */
  readonly instances: FirehoseBoxInstanceConfig[]
  /** The Route53 hosted zone for the parent domain (e.g. serverless.social). */
  readonly hostedZone: route53.IHostedZone
  /** instanceId to use when no X-PDS-Instance header is present. */
  readonly defaultInstanceId: string
  readonly projectSlug?: string
  readonly assetDirectory?: string
}

// ---------------------------------------------------------------------------
// FirehoseBox construct
// ---------------------------------------------------------------------------

/**
 * FirehoseBox — multi-instance AT Protocol firehose server on a t4g.nano EC2 instance.
 *
 * Resources created (all additive to the parent stack):
 *   - Security Group (ingress 443+80 from ::/0, egress all v4+v6)
 *   - IAM Role (AmazonSSMManagedInstanceCore + DDB read + SSM GetParameter)
 *   - SSM StringParameter /serverless-social/firehose-registry (registry JSON)
 *   - S3 Asset (firehose-box/ dir: dist/server.bundle.cjs + package.json + Caddyfile)
 *   - EC2 Instance (AL2023 arm64, t4g.nano, dual-stack VPC, IPv6-only ENI)
 *   - Route53 AAAA record firehose.<domain> → the ENI's IPv6 address
 *
 * VPC selection:
 *   Default VPC via Vpc.fromLookup (requires account/region context → works in CI
 *   and with `cdk synth` when AWS credentials are present). If you need to skip
 *   the VPC lookup in tests or environments without a default VPC, pass CDK context
 *   `fhUseDefaultVpc=false` (e.g. `cdk synth -c fhUseDefaultVpc=false`); the
 *   construct then provisions a minimal 1-AZ public-subnet VPC with no NAT gateway.
 *
 * Bundling:
 *   The esbuild bundle at infra/firehose-box/dist/server.bundle.cjs is built by
 *   `npm run build` in infra/firehose-box/ and COMMITTED to the repo so the CDK
 *   asset packaging step does not require a build-time esbuild invocation.
 *   The test suite verifies the bundle loads cleanly.
 */
export class FirehoseBox extends Construct {
  /** Full subdomain served by this box, e.g. 'firehose.serverless.social'. */
  readonly domain: string

  /** The box's public IPv6 address (primary IPv6 of its ENI). It has no public IPv4. */
  readonly ipv6Address: string

  constructor(scope: Construct, id: string, props: FirehoseBoxProps) {
    super(scope, id)

    const stack = cdk.Stack.of(this)
    this.domain = `firehose.${props.hostedZone.zoneName}`

    // -----------------------------------------------------------------------
    // SSM Registry parameter
    // -----------------------------------------------------------------------
    const registryValue = JSON.stringify({
      defaultInstanceId: props.defaultInstanceId,
      instances: Object.fromEntries(
        props.instances.map((inst) => [
          inst.instanceId,
          {
            repoTable: inst.repoTable.tableName,
            did: inst.did,
            // dids[] advertises all DIDs for this instance (apex first, then sub-users).
            // Backward-compat: existing consumers that only read `did` are unaffected.
            // Caller contract: the caller is expected to include the instance's own (apex)
            // DID as position-0 of inst.dids; this construct does NOT auto-insert it.
            // The [inst.did] branch is only a defensive fallback for callers that omit dids entirely.
            dids: inst.dids && inst.dids.length > 0 ? inst.dids : [inst.did],
          },
        ]),
      ),
    })

    const registryParam = new ssm.StringParameter(this, 'RegistryParam', {
      parameterName: `/${props.projectSlug ?? 'serverless-social'}/firehose-registry`,
      stringValue: registryValue,
      description: 'Firehose box instance registry (JSON)',
    })

    // -----------------------------------------------------------------------
    // VPC selection
    //
    // Default: provision a minimal 1-AZ public-subnet VPC with no NAT gateway.
    // This avoids the Vpc.fromLookup 'default VPC' context-lookup which fails
    // when no default VPC exists in the account (common in production accounts
    // where the default VPC has been deleted for security reasons).
    //
    // To use the account's default VPC instead (requires it to exist AND for
    // cdk.context.json to have the VPC lookup result), pass CDK context
    // `fhUseDefaultVpc=true` (e.g. `cdk synth -c fhUseDefaultVpc=true`).
    // -----------------------------------------------------------------------
    const useDefault = scope.node.tryGetContext('fhUseDefaultVpc') === 'true'
    const vpc = useDefault
      ? ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true })
      : new ec2.Vpc(this, 'FirehoseVpc', {
          maxAzs: 1,
          natGateways: 0,
          // IPv6-only box (2026-11-01): a public IPv4 address is billed
          // ($0.005/h, ~$3.70/month, more than the nano itself). The VPC is
          // dual-stack, the subnet hands out IPv6 and no public IPv4, and
          // everything the box talks to (CloudFront origin fetches, Let's
          // Encrypt, nodejs.org, caddyserver.com, npm, S3/DynamoDB/SSM
          // dual-stack endpoints) is reachable over IPv6. IMDS stays on the
          // IPv4 link-local address, which needs no public IPv4.
          ipProtocol: ec2.IpProtocol.DUAL_STACK,
          subnetConfiguration: [
            {
              name: 'Public',
              subnetType: ec2.SubnetType.PUBLIC,
              mapPublicIpOnLaunch: false,
              ipv6AssignAddressOnCreation: true,
            },
          ],
        })

    // -----------------------------------------------------------------------
    // Security Group
    // -----------------------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'FirehoseSG', {
      vpc,
      description: 'Firehose box inbound 443+80 over IPv6, outbound all',
      allowAllOutbound: true,
      // allowAllOutbound covers IPv4 only; the box's egress is IPv6.
      allowAllIpv6Outbound: true,
    })
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS from anywhere (CloudFront origin fetches)')
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP from anywhere (ACME HTTP-01, Caddy redirect to 443)')

    // -----------------------------------------------------------------------
    // IAM Role
    // -----------------------------------------------------------------------
    const role = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    })

    // DDB read-only on all instance tables + their GSI indexes
    const tableArns = props.instances.flatMap((inst) => [
      inst.repoTable.tableArn,
      `${inst.repoTable.tableArn}/index/*`,
    ])
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'FirehoseDDBRead',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:DescribeTable',
        ],
        resources: tableArns,
      }),
    )

    // SSM GetParameter for the registry param
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'FirehoseSSMRead',
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${registryParam.parameterName}`,
        ],
      }),
    )

    // -----------------------------------------------------------------------
    // S3 Asset (firehose-box directory)
    // -----------------------------------------------------------------------
    const boxDir = props.assetDirectory ?? path.join(__dirname, '..', 'firehose-box')
    const asset = new s3assets.Asset(this, 'BoxAsset', {
      path: boxDir,
      // Exclude source files and dev artifacts; ship only what the box needs.
      exclude: [
        'node_modules',
        '.npmrc',
        'build.js',
        'server.js',
        'registry.js',
        'user-data.sh',
        '*.test.*',
        '*.spec.*',
      ],
    })
    asset.grantRead(role)

    // -----------------------------------------------------------------------
    // UserData — read template and substitute tokens
    // -----------------------------------------------------------------------
    const userDataTemplate = fs.readFileSync(
      path.join(boxDir, 'user-data.sh'),
      'utf-8',
    )

    // Substitute SSM_REGISTRY_PARAM in the heredoc service unit as well.
    // We do two passes: one for the top-level variable assignment, one for the
    // inline heredoc inside the service unit (which can't use shell vars since
    // it's inside a << 'UNIT' heredoc).
    let userDataResolved = userDataTemplate
      .replace(/\{\{ASSET_S3_URL\}\}/g, asset.s3ObjectUrl)
      .replace(/\{\{SSM_REGISTRY_PARAM\}\}/g, registryParam.parameterName)

    if (this.domain !== 'firehose.serverless.social') {
      userDataResolved = userDataResolved.replace(
        'cat > /etc/systemd/system/caddy.service',
        `sed -i '1s|^[^ ]*|${this.domain}|' /opt/firehose/Caddyfile\ncat > /etc/systemd/system/caddy.service`,
      )
    }
    if (stack.region !== 'us-east-1') {
      userDataResolved = userDataResolved.replace(
        'Environment=AWS_REGION=us-east-1',
        `Environment=AWS_REGION=${stack.region}`,
      )
    }

    const userData = ec2.UserData.forLinux()
    userData.addCommands(userDataResolved)

    // -----------------------------------------------------------------------
    // EC2 Instance (AL2023 arm64, t4g.nano, public subnet)
    // -----------------------------------------------------------------------
    const instance = new ec2.Instance(this, 'FirehoseInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      // cachedInContext pins the AMI id in cdk.context.json (committed), so a
      // routine deploy no longer replaces the box whenever Amazon publishes a
      // new AL2023 image. Each replacement re-runs the bootstrap and asks Let's
      // Encrypt for a new certificate; refresh deliberately with
      // `npx cdk context --reset <key>` when a new image is wanted.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        cachedInContext: true,
      }),
      securityGroup: sg,
      role,
      userData,
      // A user-data change must REPLACE the instance. Without this CloudFormation
      // updates the user data in place and reboots, but cloud-init runs user
      // scripts once per instance id, so the new bootstrap never executes
      // (2026-11-01: the box came back with the old, OOM-killed script and
      // nothing installed). The logical id gains a user-data hash.
      userDataCausesReplacement: true,
    })

    // -----------------------------------------------------------------------
    // Dedicated ENI with one IPv6 address (no public IPv4 anywhere).
    //
    // AWS::EC2::Instance exposes no IPv6 attribute, so the address Route 53
    // needs comes from a standalone network interface the instance attaches
    // as device 0. The ENI's logical id carries the same user-data digest as
    // the instance: when a user-data change replaces the instance, the ENI
    // is replaced with it (a new ENI is created, the new instance attaches it,
    // the AAAA record moves, then the old pair is deleted). Reusing one ENI
    // across a replacement would fail, since it is still attached to the old
    // instance when the new one is created.
    // -----------------------------------------------------------------------
    const eni = new ec2.CfnNetworkInterface(this, 'FirehoseEni', {
      subnetId: vpc.publicSubnets[0].subnetId,
      groupSet: [sg.securityGroupId],
      ipv6AddressCount: 1,
      // PrimaryIpv6Address, the attribute the AAAA record reads, is only
      // populated when the interface designates a primary IPv6 address.
      // Without this the first deploy (2026-11-01) handed Route 53 an empty
      // string: AAAARRDATAIllegalIPv6Address.
      enablePrimaryIpv6: true,
      description: 'firehose box IPv6-only interface',
      tags: [{ key: 'Name', value: 'firehose-box-eni' }],
    })
    const eniLogicalId = stack.getLogicalId(eni)
    eni.overrideLogicalId(
      cdk.Lazy.uncachedString({
        produce: (ctx) => {
          const digest = createHash('md5')
            .update(JSON.stringify(ctx.resolve(userData.render())))
            .digest('hex')
            .slice(0, 16)
          return `${eniLogicalId}${digest}`
        },
      }),
    )
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance
    cfnInstance.networkInterfaces = [{ deviceIndex: '0', networkInterfaceId: eni.ref }]
    cfnInstance.addPropertyDeletionOverride('SubnetId')
    cfnInstance.addPropertyDeletionOverride('SecurityGroupIds')
    this.ipv6Address = eni.attrPrimaryIpv6Address

    // -----------------------------------------------------------------------
    // StatusCheckFailed alarm + EC2 auto-recover action (ops-hardening,
    // additive-only). Uses StatusCheckFailed_System specifically (not the
    // combined StatusCheckFailed or the StatusCheckFailed_Instance metric):
    // the ec2:RecoverInstances alarm action is only supported on an alarm
    // based on StatusCheckFailed_System — AWS stops/restarts the instance on
    // new hardware, which only helps for underlying-host failures, not
    // instance/OS-level check failures a restart can't fix. 5-min period, 2
    // evaluation periods (10 min sustained failure — avoids flapping on a
    // single transient check) before firing recover. No SNS action is
    // attached, matching the no-SNS-topic-exists-in-this-stack pattern used
    // by every other alarm here (ApDeliveryErrors/LongformRendererErrors) —
    // the ec2 recover action is the one meaningful automated remediation for
    // this metric and is additive to, not a replacement for, human alerting.
    // -----------------------------------------------------------------------
    new cloudwatch.Alarm(this, 'FirehoseInstanceStatusCheckFailed', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_System',
        dimensionsMap: { InstanceId: instance.instanceId },
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(
      new cloudwatchActions.Ec2Action(cloudwatchActions.Ec2InstanceAction.RECOVER),
    )

    // -----------------------------------------------------------------------
    // Route53 AAAA record — firehose.<domain> → the ENI's IPv6 address.
    // No A record: CloudFront connects to this origin over IPv6.
    // -----------------------------------------------------------------------
    new route53.AaaaRecord(this, 'FirehoseAaaaRecord', {
      zone: props.hostedZone,
      recordName: 'firehose',
      target: route53.RecordTarget.fromIpAddresses(eni.attrPrimaryIpv6Address),
      ttl: cdk.Duration.minutes(5),
    })
  }
}
