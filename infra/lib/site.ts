import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as deployment from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import type { FirehoseConfiguration } from "./infra-stack";

export interface ServerlessSocialSiteProps {
  readonly domain: string;
  readonly hostedZone: route53.IHostedZone;
  readonly certificate?: acm.ICertificate;
  readonly webAssetDirectory: string;
  readonly pds: {
    /** Public TLS hostname for the PDS and its subscribeRepos endpoint. */
    readonly hostname: string;
    /** Direct backend hostname for a configured tenant, e.g. its HTTP API origin. */
    readonly apiHostname?: string;
  };
  readonly firehose?: Extract<FirehoseConfiguration, { mode: "existing" }>;
}

const API_PATHS = [
  "/xrpc/*",
  "/auth/*",
  "/oauth/*",
  "/mcp",
  "/mcp/*",
  "/ap/*",
  "/.well-known/*",
];

export class ServerlessSocialSite extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ServerlessSocialSiteProps) {
    super(scope, id);
    const { domain, hostedZone, pds, firehose } = props;
    const certificate = props.certificate ?? new acm.Certificate(this, "Certificate", {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    const site = new s3.Bucket(this, "Assets", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const apiOrigin = new origins.HttpOrigin(pds.apiHostname ?? pds.hostname, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: pds.apiHostname ? { "x-pds-viewer-host": domain } : undefined,
    });
    const firehoseOrigin = new origins.HttpOrigin(firehose?.hostname ?? pds.hostname, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      ipAddressType: firehose?.ipAddressType,
      customHeaders: firehose ? { "X-PDS-Instance": firehose.instanceId } : undefined,
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    const spaRouter = new cloudfront.Function(this, "SpaRouter", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri === "/auth/complete" || /^\\/(?:profile|search|following|settings|docs|notifications|compose|longform|post)(?:\\/|$)/.test(request.uri)) {
    request.uri = '/index.html';
  }
  return request;
}
`),
    });
    const staticBehavior: cloudfront.BehaviorOptions = {
      origin: origins.S3BucketOrigin.withOriginAccessControl(site),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: spaRouter,
      }],
    };
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domain],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: staticBehavior,
      additionalBehaviors: {
        "/auth/complete": staticBehavior,
        "/xrpc/com.atproto.sync.subscribeRepos": {
          ...apiBehavior,
          origin: firehoseOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        ...Object.fromEntries(API_PATHS.map(path => [path, apiBehavior])),
      },
    });
    new route53.ARecord(this, "Alias", {
      zone: hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });
    new deployment.BucketDeployment(this, "Deploy", {
      sources: [deployment.Source.asset(props.webAssetDirectory)],
      destinationBucket: site,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: false,
    });
  }
}
