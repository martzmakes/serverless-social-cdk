import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as ses from "aws-cdk-lib/aws-ses";
import * as path from "path";
import * as fs from "fs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { DynamoEventSource, SqsDlq, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { RepoTable } from "./pds-table";
import { FirehoseWs } from "./pds-ws";
import { FirehoseBox } from "./firehose-box";
import { lambdaSource } from "./lambda-assets";
import { LongformIndexTable } from "./longform-index-table";
import { PostAnalyticsTable } from "./post-analytics-table";
import { TenantsTable } from "./tenants-table";
import { PostEditor } from "./post-editor";
import type { ArticleShareImage } from "./lambdas/pds/longform-preview";

export type FirehoseConfiguration =
  | {
      readonly mode: "create";
      readonly additionalDids?: readonly string[];
      /** Path to an existing box asset tree when adopting a deployed stack. */
      readonly assetDirectory?: string;
    }
  | {
      readonly mode: "existing";
      readonly hostname: string;
      readonly instanceId: string;
      readonly ipAddressType?: cloudfront.OriginIpAddressType;
    };

export interface ServerlessSocialStackProps extends cdk.StackProps {
  readonly domain: string;
  readonly projectSlug: string;
  readonly siteName: string;
  readonly webAssetDirectory: string;
  readonly adminEmail: string;
  readonly allowedEmails?: readonly string[];
  readonly hostedZoneId?: string;
  readonly alarmEmail?: string;
  readonly tenantHosts?: readonly string[];
  /** IANA time zones for article dates, keyed by publishing hostname. Defaults to UTC. */
  readonly articleTimeZones?: Readonly<Record<string, string>>;
  /** Default Open Graph image for articles without a cover, keyed by publishing hostname. */
  readonly articleShareImages?: Readonly<Record<string, ArticleShareImage>>;
  /** Relay hosts to notify after commits. Supply an empty array for isolated deployments. */
  readonly notifyOfUpdateTargets?: readonly string[];
  readonly firehose?: FirehoseConfiguration;
  /** Optional second distribution in the same stack. Preserve the prefix for existing deployments. */
  readonly secondarySite?: {
    readonly domain: string;
    readonly constructIdPrefix: string;
  };
  /** Preserve the historical handle override for existing installations. */
  readonly pdsHandle?: string;
  /** Add a private draft editor and scheduled publishing to the shared PDS. */
  readonly editor?: boolean;
  /** Expose site-owner Bluesky conversations through the private author API. */
  readonly directMessages?: boolean;
  /**
   * Viewer networks (IPv4/IPv6 addresses or CIDRs) left out of page-view
   * analytics, such as the author's own home network. Compared in the log
   * aggregator only; addresses are never stored.
   */
  readonly analyticsExcludeCidrs?: readonly string[];
}

export class InfraStack extends cdk.Stack {
  /** Regional backend origin for a ServerlessSocialSite attached to this deployment. */
  readonly apiHostname: string;

  constructor(scope: Construct, id: string, props: ServerlessSocialStackProps) {
    super(scope, id, props);

    const {
      domain: DOMAIN,
      projectSlug: PROJECT_SLUG,
      siteName,
      adminEmail,
      secondarySite,
    } = props;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(PROJECT_SLUG)) {
      throw new Error("projectSlug must contain lowercase letters, digits and single hyphens");
    }
    const validateDomain = (domain: string) => {
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)) {
        throw new Error(`Expected a lowercase DNS hostname, received ${domain}`);
      }
    };
    const tenantHosts = [...new Set([
      ...(props.tenantHosts ?? []),
      ...(secondarySite ? [secondarySite.domain] : []),
    ])];
    [DOMAIN, ...tenantHosts].forEach(validateDomain);
    const articleTimeZones = Object.entries(props.articleTimeZones ?? {});
    for (const [host, timeZone] of articleTimeZones) {
      validateDomain(host);
      new Intl.DateTimeFormat("en-US", { timeZone });
    }
    const articleShareImages = Object.entries(props.articleShareImages ?? {});
    for (const [host, image] of articleShareImages) {
      validateDomain(host);
      const url = new URL(image.url);
      if (url.protocol !== "https:" || url.username || url.password ||
          !Number.isInteger(image.width) || image.width <= 0 ||
          !Number.isInteger(image.height) || image.height <= 0 ||
          !["image/jpeg", "image/png"].includes(image.mimeType) || !image.alt.trim()) {
        throw new Error(`Expected an HTTPS JPEG or PNG share image with dimensions and alt text for ${host}`);
      }
    }
    const pdsHandle = props.pdsHandle ?? DOMAIN;
    const firehose = props.firehose ?? { mode: "create" };
    if (firehose.mode === "existing") {
      validateDomain(firehose.hostname);
      if (!firehose.instanceId.trim()) throw new Error("Existing firehose instanceId is required");
    }
    const KNOWN_TENANT_HOSTS = tenantHosts.join(",");
    const SES_FROM = `${siteName} <no-reply@${DOMAIN}>`;
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(adminEmail)) {
      throw new Error("adminEmail is required and must be a single email address");
    }
    const allowedEmails = [...new Set([adminEmail, ...(props.allowedEmails ?? [])])].join(",");
    const JWT_SECRET_NAME = `/${PROJECT_SLUG}/jwt-secret`;
    const APP_PASSWORD_NAME = `/${PROJECT_SLUG}/app-password`;
    const ATPROTO_SIGNING_KEY_NAME = `/${PROJECT_SLUG}/atproto-signing-key`;

    // -------------------------------------------------------------------
    // DynamoDB
    // -------------------------------------------------------------------
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // For production, change to RETAIN to prevent accidental data loss.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const magicLinkTokensTable = new dynamodb.Table(
      this,
      "MagicLinkTokensTable",
      {
        partitionKey: { name: "token", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: "ttl",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // OAuthTable — ephemeral OAuth state for MCP clients (registered clients
    // + pending auth requests) with TTL cleanup. Delete this with the rest
    // of the MCP/OAuth block if your project doesn't expose an MCP server.
    //   pk = CLIENT#<clientId> / sk = CLIENT
    //   pk = AUTH#<authCode>  / sk = AUTH
    const oauthTable = new dynamodb.Table(this, "OAuthTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // WaitlistTable — every non-allowlisted email is captured here as a
    // demand signal instead of silently dropped. RETAIN so a redeploy or
    // teardown doesn't lose the validation data.
    const waitlistTable = new dynamodb.Table(this, "WaitlistTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // RepoTable — AT Protocol single-tenant PDS repo storage (pk/sk single-table).
    // RETAIN + PITR — see infra/lib/pds-table.ts for key design.
    const repoTable = new RepoTable(this, "RepoTable");

    // TenantsTable — Sub-user tenant registry (pk=did; GSIs byHandle, byDomain).
    const tenantsTable = new TenantsTable(this, "TenantsTable");

    // -------------------------------------------------------------------
    // ActivityPub bridge tables (Spec #7 / Phase C — ADDITIVE).
    //
    // Brand-new pk/sk namespaces, separate from the AT RepoTable/TenantsTable.
    // Nothing here touches the apex AT repo, firehose, did.json, or signing
    // key — the AP bridge is purely additive.
    //
    // Key schema MATCHES exactly what infra/lib/lambdas/ap-deps.ts writes:
    //   ApFollowersTable  makeFollowersStore: Item { pk:<handle>, sk:<actorId>,
    //                      inbox, addedAt }  → pk/sk both STRING.
    //   ApActorCacheTable makeActorCache:    Item { pk:<actorId>,
    //                      publicKeyPem, inbox, ttl:<epochSeconds> }
    //                      → pk STRING, TTL attribute literally named "ttl"
    //                        (ap-deps also honors it defensively in-code).
    // -------------------------------------------------------------------
    const apFollowersTable = new dynamodb.Table(this, "ApFollowersTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Followers are durable AP federation state — RETAIN so a redeploy or
      // teardown doesn't silently drop every remote follower relationship.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const apActorCacheTable = new dynamodb.Table(this, "ApActorCacheTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // TTL'd remote-actor signing-key cache — pure cache, safe to DESTROY.
      // Attribute name MUST be "ttl" to match ap-deps.ts makeActorCache().
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task 11 — people the owner follows on Mastodon, and the posts ingested
    // from them. Key layouts match ap-deps.ts makeFollowingStore/makeInboundStore.
    //   ApFollowingTable     pk=<handle> sk=<remote actor id>; state pending|accepted.
    //                        Durable relationship state: RETAIN + PITR.
    //   ApInboundPostsTable  pk=<handle> sk=<sha256 of object/announce id>,
    //                        sortKey=<published ISO>#<key prefix> (GSI byPublished),
    //                        owner, item, ttl = 90 days. Derived/cache data
    //                        (remote content), but PITR is on per the plan.
    const apFollowingTable = new dynamodb.Table(this, "ApFollowingTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const apInboundPostsTable = new dynamodb.Table(this, "ApInboundPostsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    apInboundPostsTable.addGlobalSecondaryIndex({
      indexName: "byPublished",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sortKey", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // BlobBucket — AT Protocol blob storage (images, avatars, banners).
    // Private, RETAIN so blobs survive stack teardown/redeploy. Versioned +
    // a 90-day noncurrent-version expiration (ops-hardening, additive-only):
    // blob keys are content-addressed CIDs so same-key overwrite-with-
    // different-content isn't a realistic failure mode — the real risk this
    // guards against is an accidental/malicious DELETE (no code path calls
    // DeleteObjectCommand against this bucket today, but versioning makes
    // that reversible instead of destructive). The 90-day noncurrent-version
    // expiration bounds storage growth from any future overwrite/delete
    // traffic instead of retaining every version forever.
    const blobBucket = new s3.Bucket(this, "BlobBucket", {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // -------------------------------------------------------------------
    // SSM secrets (created out-of-band; see docs/setup.md)
    // -------------------------------------------------------------------
    const jwtSecretParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "JwtSecretParam",
        { parameterName: JWT_SECRET_NAME }
      );

    // AT Protocol signing key — hex-encoded secp256k1 private key, stored as
    // SecureString. Generated once via scripts/pds-genkey.sh; never rotated
    // without a DID document update.
    const atprotoSigningKeyParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "AtprotoSigningKeyParam",
        { parameterName: ATPROTO_SIGNING_KEY_NAME }
      );

    // -------------------------------------------------------------------
    // Lambda defaults
    // -------------------------------------------------------------------
    const lambdaEnv: Record<string, string> = {
      USERS_TABLE: usersTable.tableName,
      MAGIC_LINK_TOKENS_TABLE: magicLinkTokensTable.tableName,
      OAUTH_TABLE: oauthTable.tableName,
      JWT_SECRET_NAME,
      PROJECT_SLUG,
      DOMAIN,
    };

    const lambdaDefaults = {
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
        externalModules: [] as string[],
      },
    };

    // -------------------------------------------------------------------
    // Auth HTTP API + Lambdas
    // -------------------------------------------------------------------
    const authHttpApi = new apigwv2.HttpApi(this, "AuthHttpApi", {
      apiName: `${PROJECT_SLUG}-auth`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          ...(props.editor ? [apigwv2.CorsHttpMethod.PUT] : []),
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type", "mcp-protocol-version"],
        exposeHeaders: ["www-authenticate"],
      },
    });

    const authLambdaBase = {
      ...lambdaDefaults,
      environment: {
        ...lambdaEnv,
        VERIFY_BASE_URL: `${authHttpApi.apiEndpoint}/auth/verify`,
        SITE_URL: `https://${DOMAIN}`,
        SES_FROM_ADDRESS: SES_FROM,
        KNOWN_TENANT_HOSTS,
        WAITLIST_TABLE: waitlistTable.tableName,
        ALLOWED_EMAILS: allowedEmails,
      },
    };
    const postAnalytics = new PostAnalyticsTable(this, "PostAnalyticsTable");

    if (props.directMessages) {
      const directMessages = new lambda.NodejsFunction(this, "DirectMessages", {
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(24),
        environment: {
          DOMAIN,
          PROJECT_SLUG,
          JWT_SECRET_NAME,
          PDS_HANDLE: pdsHandle,
          TENANTS_TABLE: tenantsTable.table.tableName,
          KNOWN_TENANT_HOSTS,
          ALLOWED_EMAILS: allowedEmails,
          SIGNING_KEY_PARAM: ATPROTO_SIGNING_KEY_NAME,
        },
        ...lambdaSource("chat/handler"),
      });
      jwtSecretParam.grantRead(directMessages);
      atprotoSigningKeyParam.grantRead(directMessages);
      tenantsTable.table.grantReadData(directMessages);
      directMessages.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [this.formatArn({
          service: "ssm",
          resource: "parameter",
          resourceName: `${PROJECT_SLUG}/tenants/*/signing`,
        })],
      }));
      const chatIntegration = new apigwv2Integrations.HttpLambdaIntegration("DirectMessagesIntegration", directMessages);
      authHttpApi.addRoutes({
        path: "/auth/messages",
        methods: [apigwv2.HttpMethod.GET],
        integration: chatIntegration,
      });
      authHttpApi.addRoutes({
        path: "/auth/messages/conversations",
        methods: [apigwv2.HttpMethod.POST],
        integration: chatIntegration,
      });
      authHttpApi.addRoutes({
        path: "/auth/messages/conversations/{conversationId}",
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: chatIntegration,
      });
    }

    const postEditor = props.editor
      ? new PostEditor(this, "PostEditor", {
        api: authHttpApi,
        tenants: tenantsTable.table,
        sharingTable: postAnalytics.table,
        jwtSecret: jwtSecretParam,
        environment: {
          DOMAIN,
          PROJECT_SLUG,
          PDS_HANDLE: pdsHandle,
          JWT_SECRET_NAME,
          ALLOWED_EMAILS: allowedEmails,
          KNOWN_TENANT_HOSTS,
        },
      })
      : undefined;

    const requestMagicLinkHandler = new lambda.NodejsFunction(
      this,
      "AuthRequestHandler",
      {
        ...authLambdaBase,
        ...lambdaSource("auth/request"),
      }
    );

    const verifyMagicLinkHandler = new lambda.NodejsFunction(
      this,
      "AuthVerifyHandler",
      {
        ...authLambdaBase,
        ...lambdaSource("auth/verify"),
      }
    );

    const meHandler = new lambda.NodejsFunction(this, "AuthMeHandler", {
      ...authLambdaBase,
      environment: {
        ...authLambdaBase.environment,
        TENANTS_TABLE: tenantsTable.table.tableName,
        ADMIN_EMAIL: adminEmail,
        PDS_HANDLE: pdsHandle,
      },
      ...lambdaSource("auth/me"),
    });

    // GET /auth/pds-session — mints a plain-Bearer DID-scoped xrpc session for
    // the sub-user tenant the authenticated email owns (first-party path, no DPoP).
    // Apex/admin falls back to the apex tenant session.
    const pdsSessionHandler = new lambda.NodejsFunction(
      this,
      "AuthPdsSessionHandler",
      {
        ...authLambdaBase,
        environment: {
          ...authLambdaBase.environment,
          TENANTS_TABLE: tenantsTable.table.tableName,
          JWT_SECRET_PARAM: JWT_SECRET_NAME,
          ADMIN_EMAIL: adminEmail,
        },
        ...lambdaSource("auth/pds-session"),
      }
    );

    magicLinkTokensTable.grantReadWriteData(requestMagicLinkHandler);
    waitlistTable.grantWriteData(requestMagicLinkHandler);
    magicLinkTokensTable.grantReadWriteData(verifyMagicLinkHandler);
    usersTable.grantReadWriteData(verifyMagicLinkHandler);
    usersTable.grantReadWriteData(meHandler);
    oauthTable.grantReadWriteData(verifyMagicLinkHandler); // for OAuth handoff
    jwtSecretParam.grantRead(verifyMagicLinkHandler);
    jwtSecretParam.grantRead(meHandler);
    // me handler: byEmail GSI read for did/handle resolution
    tenantsTable.table.grantReadData(meHandler);
    // pds-session handler: byEmail GSI read + jwt secret for session minting
    tenantsTable.table.grantReadData(pdsSessionHandler);
    jwtSecretParam.grantRead(pdsSessionHandler);

    requestMagicLinkHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    authHttpApi.addRoutes({
      path: "/auth/request",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthRequestIntegration",
        requestMagicLinkHandler
      ),
    });

    authHttpApi.addRoutes({
      path: "/auth/verify",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthVerifyIntegration",
        verifyMagicLinkHandler
      ),
    });

    authHttpApi.addRoutes({
      path: "/auth/me",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
      ],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthMeIntegration",
        meHandler
      ),
    });

    authHttpApi.addRoutes({
      path: "/auth/pds-session",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthPdsSessionIntegration",
        pdsSessionHandler
      ),
    });

    // -------------------------------------------------------------------
    // MCP server + OAuth (for Claude Desktop / remote MCP clients)
    // Delete this whole block (and the OAuthTable above + lambdas/mcp +
    // lambdas/oauth + app/src/hooks/useMcp.ts) if you don't expose MCP.
    // See docs/mcp.md for what this enables and how to extend.
    // -------------------------------------------------------------------
    const oauthHandler = new lambda.NodejsFunction(this, "OAuthHandler", {
      ...authLambdaBase,
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      ...lambdaSource("oauth/handler"),
    });

    oauthTable.grantReadWriteData(oauthHandler);
    magicLinkTokensTable.grantReadWriteData(oauthHandler);
    waitlistTable.grantWriteData(oauthHandler); // for allowlist-gate waitlist writes
    jwtSecretParam.grantRead(oauthHandler);
    oauthHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    for (const p of [
      // MCP OAuth discovery — DISTINCT from the AT-Proto OAuth server, which
      // owns the canonical /.well-known/oauth-(authorization-server|protected-
      // resource) paths (PAR + DPoP). The MCP advertises a /mcp-scoped resource
      // + issuer, served at both the RFC 8414 path-insertion form
      // (/.well-known/<doc>/mcp) and the OIDC path-append form
      // (/mcp/.well-known/<doc>) so any compliant MCP client lands on this
      // magic-link AS (no PAR). The legacy mcp-oauth-* path is kept for compat.
      "/.well-known/mcp-oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/mcp/.well-known/oauth-authorization-server",
      "/mcp/.well-known/oauth-protected-resource",
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/email",
      "/oauth/consent",
      "/oauth/token",
    ]) {
      authHttpApi.addRoutes({
        path: p,
        methods: [
          apigwv2.HttpMethod.GET,
          apigwv2.HttpMethod.POST,
          apigwv2.HttpMethod.OPTIONS,
        ],
        integration: new apigwv2Integrations.HttpLambdaIntegration(
          `OAuthIntegration_${p.replace(/[^a-zA-Z0-9]/g, "_")}`,
          oauthHandler
        ),
      });
    }

    const mcpHandler = new lambda.NodejsFunction(this, "McpHandler", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...lambdaDefaults.environment,
        MCP_PUBLIC_BASE: `https://${DOMAIN}`,
        // Spec #6 T9 — domain tools (list_accounts / create_post /
        // create_longform / delete_record) read these:
        TENANTS_TABLE: tenantsTable.table.tableName,
        APEX_DID: `did:web:${DOMAIN}`,
        APEX_HANDLE: DOMAIN,
        ALLOWED_EMAILS: allowedEmails,
        PDS_ORIGIN: `https://${DOMAIN}`,
        JWT_SECRET_PARAM: JWT_SECRET_NAME,
        // MCP_WIDGET_DOMAIN: "<sha256(mcpUrl).slice(0,32)>.claudemcpcontent.com",
        // ^ uncomment + set after first deploy. Compute with:
        //     scripts/mcp-sandbox-domain.sh https://<your-domain>/mcp
      },
      ...lambdaSource("mcp/server"),
    });

    usersTable.grantReadWriteData(mcpHandler);
    jwtSecretParam.grantRead(mcpHandler);
    // Spec #6 T9 — domain tools read entitlements via resolveApprovedDids
    // (TenantsTable byEmail GSI) and mint per-DID sessions via TenantsTable lookup.
    tenantsTable.table.grantReadData(mcpHandler);

    authHttpApi.addRoutes({
      path: "/mcp",
      methods: [
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
      ],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "McpIntegration",
        mcpHandler
      ),
    });

    // Dedicated widget-HTML endpoint. Claude maps ui://<slug>/<name> to
    // GET /mcp/ui/<name> and iframes the response.
    authHttpApi.addRoutes({
      path: "/mcp/ui/{proxy+}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "McpUiIntegration",
        mcpHandler
      ),
    });
    // -------------------------------------------------------------------
    // End MCP + OAuth block
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // AT Protocol OAuth handler — canonical OAuth 2.1 + DPoP + PAR for
    // atproto clients (distinct from the MCP OAuth handler above). Owns the
    // canonical RFC 8414/9728 metadata documents:
    //   /.well-known/oauth-authorization-server
    //   /.well-known/oauth-protected-resource   (MOVED off McpHandler — see G1)
    // and the atproto OAuth endpoints under /oauth/atproto/*.
    // -------------------------------------------------------------------
    const atprotoOAuthHandler = new lambda.NodejsFunction(
      this,
      "AtprotoOAuthHandler",
      {
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(15),
        memorySize: 512,
        environment: {
          ...lambdaEnv,
          // Canonical issuer = apex origin (e.g. https://serverless.social).
          ISSUER: `https://${DOMAIN}`,
          TENANTS_TABLE: tenantsTable.table.tableName,
          // Handler reads process.env.JWT_SECRET_PARAM (the SSM param NAME);
          // mirrors the pds/handler.ts wiring.
          JWT_SECRET_PARAM: JWT_SECRET_NAME,
          SES_FROM_ADDRESS: SES_FROM,
          // Apex owner — destination for the apex magic-link sign-in.
          ADMIN_EMAIL: adminEmail,
        },
        ...lambdaSource("atproto-oauth/handler"),
      }
    );

    oauthTable.grantReadWriteData(atprotoOAuthHandler);
    tenantsTable.table.grantReadData(atprotoOAuthHandler); // covers byHandle GSI
    magicLinkTokensTable.grantReadWriteData(atprotoOAuthHandler);
    jwtSecretParam.grantRead(atprotoOAuthHandler);
    atprotoOAuthHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    for (const p of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/oauth/atproto/par",
      "/oauth/atproto/authorize",
      "/oauth/atproto/token",
    ]) {
      authHttpApi.addRoutes({
        path: p,
        methods: [
          apigwv2.HttpMethod.GET,
          apigwv2.HttpMethod.POST,
          apigwv2.HttpMethod.OPTIONS,
        ],
        integration: new apigwv2Integrations.HttpLambdaIntegration(
          `AtprotoOAuthIntegration_${p.replace(/[^a-zA-Z0-9]/g, "_")}`,
          atprotoOAuthHandler
        ),
      });
    }
    // -------------------------------------------------------------------
    // End AT Protocol OAuth block
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // AT Protocol PDS — XRPC handler
    //
    // Serves /xrpc/<nsid>, /.well-known/did.json, /.well-known/atproto-did
    // on the same HTTP API as the rest of the backend, fronted by the same
    // CloudFront distribution. Binary CAR responses (com.atproto.sync.getRepo)
    // use isBase64Encoded=true in the Lambda response — APIGW HTTP API passes
    // this through transparently without any special binary-media-type config.
    // -------------------------------------------------------------------
    const xrpcHandler = new lambda.NodejsFunction(this, "XrpcHandler", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...lambdaDefaults.environment,
        REPO_TABLE: repoTable.table.tableName,
        TENANTS_TABLE: tenantsTable.table.tableName,
        SIGNING_KEY_PARAM: ATPROTO_SIGNING_KEY_NAME,
        JWT_SECRET_PARAM: JWT_SECRET_NAME,
        PDS_APP_PASSWORD_PARAM: APP_PASSWORD_NAME,
        // D2: shared DPoP jti replay-guard table (SAME physical OAuthTable as
        // the token endpoint). Apex/first-party plain-Bearer tokens never
        // reach the jti branch, so this is additive-only for the apex path.
        OAUTH_TABLE: oauthTable.tableName,
        BLOB_BUCKET: blobBucket.bucketName,
        // Threads the per-deployment handle into the Lambda so lexicons.ts
        // derives HANDLE/DID/PDS_ENDPOINT from process.env.PDS_HANDLE.
        // Default ('serverless.social') ⇒ zero behavior change for live stack.
        PDS_HANDLE: pdsHandle,
        ADMIN_EMAIL: adminEmail,
      },
      ...lambdaSource("pds/handler"),
    });

    repoTable.table.grantReadWriteData(xrpcHandler);
    tenantsTable.table.grantReadData(xrpcHandler);
    // D2 (additive, least-privilege): the xrpc/PDS jti-replay guard
    // (makeXrpcSeenJti) ONLY ever issues a conditional PutCommand against the
    // OAuth table — it never reads it. So this is the tightest sufficient
    // grant: WRITE-ONLY (grantWriteData covers dynamodb:PutItem). This is
    // deliberately NARROWER than the atproto-oauth handler's grant: that
    // handler legitimately needs ReadWrite for its GetCommand reads of OAuth
    // state (client registrations, PAR requests, auth codes); the xrpc jti
    // guard does not, so it must not be able to read OAuth state. Scoped to
    // this one table; NO Route53, NO new Lambda, NO other resource.
    oauthTable.grantWriteData(xrpcHandler);
    atprotoSigningKeyParam.grantRead(xrpcHandler);
    jwtSecretParam.grantRead(xrpcHandler);
    ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "AppPasswordParam",
      { parameterName: APP_PASSWORD_NAME }
    ).grantRead(xrpcHandler);
    blobBucket.grantReadWrite(xrpcHandler);
    // Tenant-parameterized writes (writeCtx) load each sub-user's signing key
    // from /serverless-social/tenants/<encodedDid>/signing. Without this the
    // apex still works (apex uses atprotoSigningKeyParam) but every sub-user
    // authenticated write fails SSM AccessDenied → generic 500.
    xrpcHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: `${PROJECT_SLUG}/tenants/*`,
          }),
        ],
      })
    );

    // /xrpc/* — catch-all XRPC proxy
    authHttpApi.addRoutes({
      path: "/xrpc/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
        apigwv2.HttpMethod.ANY,
      ],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "XrpcIntegration",
        xrpcHandler
      ),
    });

    // /.well-known/did.json — DID document (served by xrpcHandler)
    authHttpApi.addRoutes({
      path: "/.well-known/did.json",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "PdsDidJsonIntegration",
        xrpcHandler
      ),
    });

    // /.well-known/atproto-did — plain-text DID (served by xrpcHandler)
    authHttpApi.addRoutes({
      path: "/.well-known/atproto-did",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "PdsAtprotoDidIntegration",
        xrpcHandler
      ),
    });
    // -------------------------------------------------------------------
    // End PDS block
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // ActivityPub bridge (Spec #7 / Phase C — ADDITIVE).
    //
    // Two NEW Lambdas, fronted by the SAME HTTP API + CloudFront:
    //   ApHandler   — GET /.well-known/webfinger + /ap/{proxy+}
    //                 (webfinger, actor, outbox, followers, signed inbox).
    //   ApDelivery  — RepoTable DDB-stream consumer; fans new app.bsky.feed.post
    //                 records out to remote AP followers (best-effort).
    //
    // CARDINAL RULE: AP is purely additive. Neither Lambda writes the AT repo,
    // firehose, did.json, sequencer, or the AT secp256k1 signing key. AP only
    // READS RepoTable (outbox/post projection) + TenantsTable (handle/did
    // resolution incl. the byHandle GSI). AP actor keys live in the SEPARATE
    // /serverless-social/ap/* SSM namespace (RSA-2048; cannot sign AT commits).
    //
    // Env vars set here are EXACTLY what handler.ts (PDS_HANDLE),
    // ap-deps.ts (AP_FOLLOWERS_TABLE, AP_ACTOR_CACHE_TABLE, REPO_TABLE via
    // pds/lexicons ENV, TENANTS_TABLE via pds/lexicons ENV) and deliver.ts
    // (same ap-deps-backed env, since it imports makeDeliverDeps) read.
    // -------------------------------------------------------------------
    // Ledger of (activityId, inbox) sends: a conditional write per send makes a
    // replayed stream batch / redelivered SQS message a no-op. TTL'd (7 d) and
    // purely derived state, so DESTROY is safe.
    const apDeliveryLedgerTable = new dynamodb.Table(this, "ApDeliveryLedgerTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Retry queue: transient delivery failures and not-yet-rendered longforms.
    // Backoff is set per message by ap/retry.ts (ChangeMessageVisibility from
    // ApproximateReceiveCount); the redrive policy sends a message to the DLQ
    // after maxReceiveCount receives (~6 attempts over ~3 h).
    const apDeliveryRetryDlq = new sqs.Queue(this, "ApDeliveryRetryDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const apDeliveryRetryQueue = new sqs.Queue(this, "ApDeliveryRetryQueue", {
      // >= 6x the consumer timeout (30 s) as the Lambda ESM requires.
      visibilityTimeout: cdk.Duration.seconds(180),
      retentionPeriod: cdk.Duration.days(2),
      deadLetterQueue: { queue: apDeliveryRetryDlq, maxReceiveCount: 6 },
    });

    // The renderer's published-longform index (declared here, ahead of its
    // renderer, because AP needs it to build Article urls).
    const longformIndex = new LongformIndexTable(this, "LongformIndexTable", { launchStream: !!postEditor });
    postEditor?.configureLaunches({
      index: longformIndex.table,
      apRetryQueue: apDeliveryRetryQueue,
      apCustomHosts: KNOWN_TENANT_HOSTS,
    });

    const apLambdaEnv = {
      ...lambdaDefaults.environment,
      AP_RETRY_QUEUE_URL: apDeliveryRetryQueue.queueUrl,
      AP_LEDGER_TABLE: apDeliveryLedgerTable.tableName,
      AP_INBOUND_TABLE: apInboundPostsTable.tableName,
      LONGFORM_INDEX_TABLE: longformIndex.table.tableName,
      REPO_TABLE: repoTable.table.tableName,
      TENANTS_TABLE: tenantsTable.table.tableName,
      AP_FOLLOWERS_TABLE: apFollowersTable.tableName,
      AP_ACTOR_CACHE_TABLE: apActorCacheTable.tableName,
      // pds/lexicons.ts derives HANDLE/PDS_ENDPOINT/APEX_DID from PDS_HANDLE;
      // default 'serverless.social' ⇒ zero behavior change for the live stack.
      PDS_HANDLE: pdsHandle,
      // Handles served from their own host (canonical AP origin).
      AP_CUSTOM_HOSTS: KNOWN_TENANT_HOSTS,
    };

    // SSM policy for the AP RSA actor-key namespace ONLY. ap/keys.ts
    // (getOrMintApKey via apKeyRef) does GetParameter on miss then
    // PutParameter(SecureString, Overwrite:false) to mint; the path is
    // /serverless-social/ap/<encoded-handle>/rsa. Scoped to /ap/* so an AP
    // key compromise can never read/forge the AT /tenants/* signing keys.
    const apSsmPolicy = new iam.PolicyStatement({
      actions: ["ssm:GetParameter", "ssm:PutParameter"],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: "ssm",
          resource: "parameter",
          resourceName: `${PROJECT_SLUG}/ap/*`,
        }),
      ],
    });

    const privateMentions = props.directMessages ? new dynamodb.Table(this, "ApPrivateMessages", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    }) : undefined;

    const apHandler = new lambda.NodejsFunction(this, "ApHandler", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      // The inbox is attacker-facing and now writes (following + inbound
      // tables) and does outbound fetches; bound concurrency so a flood cannot
      // run away with DynamoDB/egress cost. Remotes retry throttled deliveries.
      reservedConcurrentExecutions: 20,
      environment: {
        ...apLambdaEnv,
        // Task 11 owner routes: this handler alone owns these tables, and
        // verifies the first-party session JWT (same secret as /xrpc).
        AP_FOLLOWING_TABLE: apFollowingTable.tableName,
        JWT_SECRET_PARAM: JWT_SECRET_NAME,
        ...(privateMentions ? {
          AP_PRIVATE_MESSAGES_TABLE: privateMentions.tableName,
          ALLOWED_EMAILS: allowedEmails,
          KNOWN_TENANT_HOSTS,
        } : {}),
      },
      ...lambdaSource("ap/handler"),
    });

    // AP handler IAM — followers RW, actor cache RW, AP-key SSM, repo READ
    // (outbox projection), tenants READ incl. the byHandle GSI.
    apFollowersTable.grantReadWriteData(apHandler);
    apActorCacheTable.grantReadWriteData(apHandler);
    apDeliveryLedgerTable.grantReadWriteData(apHandler);
    repoTable.table.grantReadData(apHandler);
    tenantsTable.table.grantReadData(apHandler); // covers byHandle GSI
    apHandler.addToRolePolicy(apSsmPolicy);
    // Outbox/articles read the renderer's index; a failed Accept is queued.
    longformIndex.table.grantReadData(apHandler);
    apDeliveryRetryQueue.grantSendMessages(apHandler);
    // Item and index access for the signed-in timeline and ActivityPub article replies.
    apHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ],
        resources: [apFollowingTable.tableArn],
      })
    );
    apHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ],
        resources: [
          apInboundPostsTable.tableArn,
          `${apInboundPostsTable.tableArn}/index/byPublished`,
        ],
      })
    );
    // Owner auth verifies the session JWT with the shared secret (read only).
    jwtSecretParam.grantRead(apHandler);

    const apIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "ApIntegration",
      apHandler
    );

    // GET /.well-known/webfinger?resource=acct:<h>@serverless.social
    authHttpApi.addRoutes({
      path: "/.well-known/webfinger",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.OPTIONS],
      integration: apIntegration,
    });

    // /ap/* — actor / outbox / followers (GET) + signed inbox (POST) + the
    // owner's following/timeline routes (POST, DELETE, GET). The API's
    // corsPreflight already allows DELETE and the Authorization header.
    authHttpApi.addRoutes({
      path: "/ap/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
      ],
      integration: apIntegration,
    });

    if (privateMentions) {
      privateMentions.grantReadWriteData(apHandler);
      authHttpApi.addRoutes({
        path: "/auth/fediverse-messages",
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: apIntegration,
      });
    }

    // ── AP delivery consumer (RepoTable DDB-stream → remote follower inboxes)
    //
    // SHAPE-cloned from the LongformRenderer construct (its own DLQ, its own
    // DynamoEventSource on the SAME RepoTable stream, its own bounded
    // reservedConcurrentExecutions + error alarm). The LongformRenderer
    // construct itself is NOT modified — this is a SEPARATE stream iterator.
    const apDeliveryDlq = new sqs.Queue(this, "ApDeliveryDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });

    const apDelivery = new lambda.NodejsFunction(this, "ApDelivery", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      // Bounded fan-out concurrency: best-effort federated delivery at
      // single-author scale; cap to protect remote inboxes + cost. The
      // longform-renderer pins 1 for KVS-ETag safety; AP delivery has no
      // shared-writer constraint but is intentionally bounded.
      reservedConcurrentExecutions: 2,
      environment: apLambdaEnv,
      ...lambdaSource("ap/deliver"),
    });

    // Delivery IAM: repo stream READ + repo READ (loadPostRecord),
    // followers READ (fan-out list), tenants READ incl. byHandle GSI
    // (resolveHandle), AP-key SSM (sign outbound deliveries).
    repoTable.table.grantStreamRead(apDelivery);
    repoTable.table.grantReadData(apDelivery);
    apFollowersTable.grantReadData(apDelivery);
    // 410 Gone removes the follower: DeleteItem only, not read/write.
    apFollowersTable.grant(apDelivery, "dynamodb:DeleteItem");
    tenantsTable.table.grantReadData(apDelivery); // covers byHandle GSI
    apDelivery.addToRolePolicy(apSsmPolicy);
    longformIndex.table.grantReadData(apDelivery);
    apDeliveryLedgerTable.grantReadWriteData(apDelivery);
    apDeliveryRetryQueue.grantSendMessages(apDelivery);

    apDelivery.addEventSource(new DynamoEventSource(repoTable.table, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 5,
      bisectBatchOnError: true,
      onFailure: new SqsDlq(apDeliveryDlq),
      // DESIGN REFINEMENT (deliberate, documented — not the plan's literal
      // wording): DO NOT filter on a `pk` prefix of
      // `RECORD#app.bsky.feed.post/`. That apex-only pk-prefix matches ONLY
      // the apex record form; a SUB-USER's record row is
      // `<did>#RECORD#app.bsky.feed.post/<rkey>` and would be SILENTLY
      // DROPPED before reaching this Lambda. DynamoDB ESM filter patterns
      // support only `prefix` (no contains/suffix), so a pk-prefix cannot
      // capture both tenancy forms. keyFor()'s record `sk` is LITERALLY
      // 'RECORD' for BOTH apex and sub-user (pds/tenant-keys.ts), so we
      // filter on sk='RECORD' (exact) + eventName=['INSERT'] instead. This
      // captures every new record row across BOTH tenancies; ap/deliver.ts's
      // pure eventsFromStream then narrows precisely to app.bsky.feed.post
      // INSERTs (longform / other-collection rows are cheaply dropped
      // in-code; bounded by reservedConcurrentExecutions). The
      // longform-renderer's apex-only `RECORD#social.serverless.longform/`
      // pk-prefix is correct for IT (apex-only render-on-write) but is the
      // WRONG shape for AP, which must federate sub-user posts too — this
      // closes Task 7's documented forward-note so the Task 11 sub-user
      // live-proof does not surface it as a federation defect.
      // Same raw-pattern idiom as the longform-renderer's
      // FilterCriteria.filter({...}) above (object pattern, not FilterRule)
      // — keeps the synthesized FilterCriteria shape consistent across the
      // two RepoTable stream consumers.
      // Task 9: INSERT -> Create, MODIFY -> Update, REMOVE -> Delete.
      // (REMOVE of a record row carries Keys only: NEW_IMAGE stream view.)
      filters: [lambdaRuntime.FilterCriteria.filter({
        eventName: ["INSERT", "MODIFY", "REMOVE"],
        dynamodb: { Keys: { sk: { S: ["RECORD"] } } },
      })],
    }));

    // ── AP delivery retry consumer (SQS -> remote follower inboxes) ──────────
    // Same read/sign surface as ApDelivery (it re-runs failed sends and
    // re-checks not-yet-rendered longforms) but NO stream read, NO send to the
    // queue (a failure is redriven by SQS itself), and consume-only on the
    // queue. Bounded concurrency like its sibling.
    const apDeliveryRetry = new lambda.NodejsFunction(this, "ApDeliveryRetry", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: 2,
      environment: apLambdaEnv,
      ...lambdaSource("ap/retry"),
    });
    repoTable.table.grantReadData(apDeliveryRetry);
    apFollowersTable.grantReadData(apDeliveryRetry);
    apFollowersTable.grant(apDeliveryRetry, "dynamodb:DeleteItem");
    tenantsTable.table.grantReadData(apDeliveryRetry);
    longformIndex.table.grantReadData(apDeliveryRetry);
    apDeliveryLedgerTable.grantReadWriteData(apDeliveryRetry);
    for (const worker of [apDelivery, apDeliveryRetry]) {
      worker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [apInboundPostsTable.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["bluesky-only#*"] } },
      }));
    }
    apDeliveryRetry.addToRolePolicy(apSsmPolicy);
    // Receive/Delete/ChangeMessageVisibility/GetQueueAttributes only.
    apDeliveryRetryQueue.grantConsumeMessages(apDeliveryRetry);
    apDeliveryRetry.addEventSource(new SqsEventSource(apDeliveryRetryQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
      maxConcurrency: 2,
    }));

    // Observability-only (mirrors LongformRendererErrors — failures are
    // durably captured in ApDeliveryDlq; no SNS at single-author scale).
    new cloudwatch.Alarm(this, "ApDeliveryErrors", {
      metric: apDelivery.metricErrors({ period: cdk.Duration.minutes(15) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "ApDeliveryRetryErrors", {
      metric: apDeliveryRetry.metricErrors({ period: cdk.Duration.minutes(15) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Anything in the retry DLQ is a delivery (or longform) that exhausted its
    // attempts: same observability-only idiom as the Lambda error alarms.
    new cloudwatch.Alarm(this, "ApDeliveryRetryDlqDepth", {
      metric: apDeliveryRetryDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Depth alarms for the other two DLQs: anything sitting there is a
    // delivery / longform render that exhausted its attempts.
    new cloudwatch.Alarm(this, "ApDeliveryDlqDepth", {
      metric: apDeliveryDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // -------------------------------------------------------------------
    // End ActivityPub bridge block
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // Phase-2 Firehose — WebSocket API + placeholder Lambdas
    //
    // Task 3 implements firehose-ws.ts (connect/disconnect/default).
    // Task 4 implements firehose-fanout.ts (DDB Streams → WS push).
    // Task 5 wires the WS URL through CloudFront (exact path behavior below).
    // Connections are stored in RepoTable as CONN#<connectionId>/CONN items.
    //
    // NOTE: This block is intentionally placed before the CloudFront
    // Distribution so that firehoseWs.api.apiId is available when building
    // the WS origin for the subscribeRepos CloudFront behavior (Task 5).
    // -------------------------------------------------------------------

    // Placeholder connect/disconnect/default handler (Task 3 replaces body).
    const firehoseWsHandler = new lambda.NodejsFunction(
      this,
      "FirehoseWsHandler",
      {
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: {
          ...lambdaDefaults.environment,
          REPO_TABLE: repoTable.table.tableName,
          SIGNING_KEY_PARAM: ATPROTO_SIGNING_KEY_NAME,
        },
        ...lambdaSource("pds/firehose-ws"),
      }
    );

    // DDB Streams → WebSocket fanout (Task 4 implementation).
    // WS_MGMT_ENDPOINT is set after firehoseWs is created below (see addendum).
    const firehoseFanoutHandler = new lambda.NodejsFunction(
      this,
      "FirehoseFanoutHandler",
      {
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: {
          ...lambdaDefaults.environment,
          REPO_TABLE: repoTable.table.tableName,
          // WS_MGMT_ENDPOINT is added after firehoseWs is constructed below.
          // notifyOfUpdate: fire-and-forget POST to each comma-separated target
          // after every batch with >= 1 EVT# INSERT. bsky.network is the public
          // AT-Proto relay — adding it here closes the propagation gap where
          // the relay would otherwise only learn of new commits on its own
          // reconnect cadence (observed >11h between reconnects).
          NOTIFY_OF_UPDATE_TARGETS: (props.notifyOfUpdateTargets ?? ["bsky.network"]).join(","),
          PDS_HOSTNAME: DOMAIN,
        },
        ...lambdaSource("pds/firehose-fanout"),
      }
    );

    // Grant both Lambdas read/write on RepoTable (connections + event replay).
    repoTable.table.grantReadWriteData(firehoseWsHandler);
    repoTable.table.grantReadWriteData(firehoseFanoutHandler);

    // WebSocket API — connect/disconnect/default all handled by the same
    // placeholder Lambda until Task 3 splits them.
    const firehoseWs = new FirehoseWs(this, "FirehoseWs", {
      connectFn: firehoseWsHandler,
      disconnectFn: firehoseWsHandler,
      defaultFn: firehoseWsHandler,
    });

    // -------------------------------------------------------------------
    // Static site (S3 + CloudFront + Route 53 + ACM + SES)
    //
    // CloudFront fronts both the S3 static bundle (default behavior) AND
    // the API Gateway endpoints. Routing API traffic through the same
    // custom domain is REQUIRED for Claude's MCP Apps widgets — Claude
    // rejects ui.domain hints from raw *.execute-api.* URLs ("local
    // connector" error). Other clients still work without the proxy, but
    // widgets won't render.
    // -------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ── Longform SEO + syndication pipeline ───────────────────────────────
    // (longformIndex is declared earlier, in the ActivityPub block: AP reads the
    // renderer's index for Article urls. Construct ids are unchanged.)

    // KVS backing the viewer-request function (slug -> "301 /new" | "410").
    const longformKvs = new cloudfront.KeyValueStore(this, "LongformKvs");

    const longformEdgeFn = new cloudfront.Function(this, "LongformEdgeFn", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: longformKvs,
      comment: "Longform slug routing: reserved guard, 301/410, /<slug>/index.html",
      code: cloudfront.FunctionCode.fromInline(
        fs.readFileSync(path.join(__dirname, "longform-edge.js"), "utf8")
          .replaceAll("serverless.social", DOMAIN)
          .replaceAll("martzmakes.com", secondarySite?.domain ?? "tenant.invalid"),
      ),
    });

    // Origin-response Lambda@Edge for the DEFAULT (S3) behavior of both site
    // distributions: turns an S3 miss (403 with OAC, 404 otherwise) into a real
    // 404 page that is cached for only 10s. This replaces the old 403/404 ->
    // /index.html custom error responses, which were distribution-wide and so
    // also masked every API 404/403 (webfinger, /ap/*, xrpc, oauth, mcp, auth).
    // Inline code (<4 KB, no env vars): Lambda@Edge forbids environment vars.
    const notFoundEdgeFn = new lambdaRuntime.Function(this, "NotFoundEdgeFn", {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambdaRuntime.Code.fromInline(
        fs.readFileSync(path.join(__dirname, "not-found-edge.js"), "utf8"),
      ),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: "Origin-response: S3 403/404 -> real 404 page, 10s cache",
      // A Lambda@Edge function and any version CloudFront replicated cannot be
      // deleted until the replicas are gone (hours after the association is
      // removed). Without RETAIN, the next code change (CloudFormation deletes
      // the superseded version) or a revert to the previous template (deletes
      // the function) fails in cleanup with "replicated function" errors.
      currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.RETAIN },
    });
    notFoundEdgeFn.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const longformDlq = new sqs.Queue(this, "LongformRendererDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });

    const longformRenderer = new lambda.NodejsFunction(this, "LongformRenderer", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      // KVS uses optimistic concurrency (IfMatch=ETag) with a fresh Describe per
      // write; this is only race-free with a SINGLE concurrent writer. Do not raise.
      reservedConcurrentExecutions: 1,
      environment: {
        ...lambdaDefaults.environment,
        REPO_TABLE: repoTable.table.tableName,
        LONGFORM_INDEX_TABLE: longformIndex.table.tableName,
        TENANTS_TABLE: tenantsTable.table.tableName,
        SITE_BUCKET: siteBucket.bucketName,
        KVS_ARN: longformKvs.keyValueStoreArn,
        PUBLIC_ORIGIN: `https://${DOMAIN}`,
        SITE_NAME: siteName,
        PDS_HANDLE: DOMAIN,
        PDS_DID: `did:web:${DOMAIN}`,
        JWT_SECRET_PARAM: JWT_SECRET_NAME,
        // Task 15: the post page's author card shows the Mastodon handle at
        // the tenant's canonical AP host (same allowlist ApHandler uses).
        AP_CUSTOM_HOSTS: KNOWN_TENANT_HOSTS,
        ...(articleTimeZones.length > 0
          ? { ARTICLE_TIME_ZONES: JSON.stringify(Object.fromEntries(articleTimeZones)) }
          : {}),
        ...(articleShareImages.length > 0
          ? { ARTICLE_SHARE_IMAGES: JSON.stringify(Object.fromEntries(articleShareImages)) }
          : {}),
      },
      ...lambdaSource("pds/longform-renderer"),
    });

    repoTable.table.grantStreamRead(longformRenderer);
    longformIndex.table.grantReadWriteData(longformRenderer);
    tenantsTable.table.grantReadData(longformRenderer);
    siteBucket.grantReadWrite(longformRenderer);
    jwtSecretParam.grantRead(longformRenderer);
    longformRenderer.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "cloudfront-keyvaluestore:PutKey",
        "cloudfront-keyvaluestore:DeleteKey",
        "cloudfront-keyvaluestore:DescribeKeyValueStore",
      ],
      resources: [longformKvs.keyValueStoreArn],
    }));

    longformRenderer.addEventSource(new DynamoEventSource(repoTable.table, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 10,
      // 5 (vs fanout's 2): renderer failures are usually transient KVS ETag
      // conflicts; with reservedConcurrency=1 + bisectBatchOnError the extra
      // retries drain to the DLQ only after genuine faults. Separate stream
      // iterator from the firehose consumer — no impact on federation.
      retryAttempts: 5,
      bisectBatchOnError: true,
      onFailure: new SqsDlq(longformDlq),
      // GAP#1 fix: canonical record pks (pds/tenant-keys.ts keyFor) are
      // apex `RECORD#social.serverless.longform/<rkey>` OR sub-tenant
      // `<did>#RECORD#social.serverless.longform/<rkey>`. Sub-tenant pks
      // start with `did:` not `RECORD#`, so a single apex-prefix pattern
      // SILENTLY DROPS every sub-tenant longform write (the eventsFromStream
      // tenant branch becomes dead code → `t/<handle>/*` never rendered).
      // DynamoDB ESM filter patterns support only prefix/exists/equals (NO
      // contains/infix/regex) and the DID varies, so we cannot prefix-match
      // `<varying-did>#RECORD#...`. We therefore OR-in a second pattern
      // matching ALL `did:`-prefixed record pks. Multiple FilterCriteria
      // patterns are OR'd by Lambda ESM. This over-delivers (every tenant
      // record write — likes/posts/etc. — invokes the renderer), so
      // eventsFromStream MUST cheaply drop any pk that is not a longform
      // record; it already discriminates via the `#RECORD#<COLL>/` infix
      // (returns no event otherwise). Cost is negligible: renderer scales to
      // zero and the early-return does no IO.
      filters: [
        lambdaRuntime.FilterCriteria.filter({
          dynamodb: { Keys: { pk: { S: [{ prefix: "RECORD#social.serverless.longform/" }] } } },
        }),
        lambdaRuntime.FilterCriteria.filter({
          dynamodb: { Keys: { pk: { S: [{ prefix: "did:" }] } } },
        }),
      ],
    }));

    if (postEditor) {
      longformRenderer.addEventSource(new DynamoEventSource(longformIndex.table, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 5,
        bisectBatchOnError: true,
        onFailure: new SqsDlq(longformDlq),
        filters: [lambdaRuntime.FilterCriteria.filter({
          dynamodb: { NewImage: { launchBluesky: { M: { uri: { S: [{ prefix: "at://" }] } } } } },
        })],
      }));
    }

    // Observability-only (no SNS action by design at single-author scale;
    // failures already durably captured in LongformRendererDlq).
    new cloudwatch.Alarm(this, "LongformRendererErrors", {
      metric: longformRenderer.metricErrors({ period: cdk.Duration.minutes(15) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "LongformRendererDlqDepth", {
      metric: longformDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // ──────────────────────────────────────────────────────────────────────

    const hostedZone = props.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
          hostedZoneId: props.hostedZoneId,
          zoneName: DOMAIN,
        })
      : route53.HostedZone.fromLookup(this, "HostedZone", { domainName: DOMAIN });

    const apexDid = `did:web:${DOMAIN}`;
    const subUserDids = firehose.mode === "create" ? firehose.additionalDids ?? [] : [];
    for (const did of subUserDids) {
      if (!did.startsWith("did:")) throw new Error(`subUserDids: "${did}" is not a DID`);
    }
    const firehoseBox = firehose.mode === "create"
      ? new FirehoseBox(this, "FirehoseBox", {
          instances: [{
            instanceId: DOMAIN,
            repoTable: repoTable.table,
            did: apexDid,
            originHeader: DOMAIN,
            dids: [apexDid, ...subUserDids],
          }],
          hostedZone,
          defaultInstanceId: DOMAIN,
          projectSlug: PROJECT_SLUG,
          assetDirectory: firehose.assetDirectory,
        })
      : undefined;

    const certificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: DOMAIN,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Build an HttpOrigin pointed at the API Gateway domain, then attach it
    // to extra behaviors so /mcp, /auth/*, /oauth/*, /.well-known/*,
    // /webhook/* all proxy to API Gateway through the same custom domain.
    const apiOriginHost = cdk.Fn.select(
      2,
      cdk.Fn.split("/", authHttpApi.apiEndpoint)
    );
    this.apiHostname = apiOriginHost;
    // CloudFront's ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy (below)
    // strips the real Host header before forwarding to API Gateway, so the
    // Lambda-side `viewerHost()` (infra/lib/lambdas/pds/handler.ts) can never
    // tell which domain the visitor hit from `host`/`Host` alone — it already
    // prefers a `x-pds-viewer-host` custom header for exactly this reason, but
    // nothing was sending one. Two origin/behavior variants (one per
    // distribution) each inject the correct static value via `customHeaders`,
    // the same pattern `firehoseBoxOrigin` uses for `X-PDS-Instance` below.
    const apiOriginApex = new cloudfrontOrigins.HttpOrigin(apiOriginHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { "x-pds-viewer-host": DOMAIN },
    });
    const apiBehaviorApex = {
      origin: apiOriginApex,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy:
        cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
    };
    // dormant: superseded by FirehoseBox in FH-T
    // The API-GW WebSocket origin below is no longer referenced by any CloudFront
    // behavior (the subscribeRepos behavior now points to the FirehoseBox).
    // Left in place intentionally to minimize diff/risk — remove in a future task.
    const wsOriginDomain = `${firehoseWs.api.apiId}.execute-api.${this.region}.amazonaws.com`;
    const wsOrigin = new cloudfrontOrigins.HttpOrigin(wsOriginDomain, {
      originPath: "/$default",
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const wsUriRewriteFn = new cloudfront.Function(this, "FirehoseWsUriRewrite", {
      comment: "Rewrite firehose WS URI to WS API stage root",
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; r.uri = '/'; return r; }"
      ),
    });
    void wsOrigin; // dormant reference — prevent unused-variable lint noise

    // Task 4 — FirehoseBox origin for the subscribeRepos CloudFront behavior.
    // The shared firehose box at firehose.serverless.social receives WebSocket
    // upgrades and routes to the correct PDS instance via X-PDS-Instance header.
    // CloudFront forwards OriginCustomHeaders on WS upgrade GETs — no binary
    // corruption (that was API-GW-WS-specific, NOT CloudFront). No OriginPath
    // needed — Caddy serves at root.
    const firehoseHostname = firehoseBox?.domain ?? (firehose.mode === "existing" ? firehose.hostname : `firehose.${DOMAIN}`);
    const firehoseBoxOrigin = new cloudfrontOrigins.HttpOrigin(firehoseHostname, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      // The box has no public IPv4 (billed address); CloudFront reaches it
      // over IPv6 (custom-origin IPv6 support, Sept 2025).
      ipAddressType: firehose.mode === "existing"
        ? firehose.ipAddressType ?? cloudfront.OriginIpAddressType.DUALSTACK
        : cloudfront.OriginIpAddressType.IPV6,
      customHeaders: {
        "X-PDS-Instance": firehose.mode === "existing" ? firehose.instanceId : DOMAIN,
      },
    });

    // CloudFront cache-behavior precedence is BY LIST ORDER (first match wins),
    // NOT by pattern specificity. The exact firehose path must therefore be
    // declared before the '/xrpc/*' wildcard in additionalBehaviors below so the
    // WS firehose path reaches the FirehoseBox while all other /xrpc/* XRPC HTTP
    // requests fall through to the HTTP API origin.
    const wsBehavior = {
      origin: firehoseBoxOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      // compress:false — never let CloudFront gzip the binary AT-Proto firehose frames.
      // (Harmless for WS pass-through since CF compression doesn't apply to the 101
      //  handshake or WS frames anyway, but kept explicit: binary integrity is critical here.)
      compress: false,
    };

    // -------------------------------------------------------------------
    // Post analytics (Spec #8 / Phase E — ADDITIVE).
    //
    // CloudFront standard access logs → private auto-expiring S3 bucket →
    // S3-ObjectCreated aggregator Lambda → PostAnalyticsTable rollups.
    //
    // CARDINAL RULE: enabling distribution logging is an ORTHOGONAL property
    // (CDK adds only a `Logging` block to DistributionConfig). It changes NO
    // behavior/origin/edge-fn/alias/cert — the apex did:web:serverless.social
    // serving config stays byte-identical (G2 synth gate proves this). Nothing
    // here touches did.json/sequencer/keyFor/storage/repo-write/longform-*/
    // longform-edge.js/the AT signing key/the firehose. The ONLY new IAM is the
    // scoped analytics grants (logs-bucket READ + analytics-table RW for the
    // aggregator; analytics-table READ for the existing xrpc/PDS handler).
    //
    // CloudFront standard logging delivery requires the log bucket to accept
    // ACLs (the log-delivery group writes objects), hence OBJECT_WRITER object
    // ownership. Still fully private (BLOCK_ALL public access) + 30-day expiry
    // so no PII is retained.
    // -------------------------------------------------------------------
    const analyticsLogsBucket = new s3.Bucket(this, "AnalyticsLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    const postInsights = new lambda.NodejsFunction(this, "PostInsights", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(27),
      environment: {
        DOMAIN,
        PROJECT_SLUG,
        JWT_SECRET_NAME,
        PDS_HANDLE: pdsHandle,
        ALLOWED_EMAILS: allowedEmails,
        KNOWN_TENANT_HOSTS,
        TENANTS_TABLE: tenantsTable.table.tableName,
        LONGFORM_INDEX_TABLE: longformIndex.table.tableName,
        POST_ANALYTICS_TABLE: postAnalytics.table.tableName,
        SITE_SHARING_TABLE: postAnalytics.table.tableName,
        SITE_BUCKET: siteBucket.bucketName,
        AP_CUSTOM_HOSTS: KNOWN_TENANT_HOSTS,
        AP_INBOUND_TABLE: apInboundPostsTable.tableName,
        REPLY_API_ORIGIN: authHttpApi.apiEndpoint,
      },
      ...lambdaSource("analytics/insights"),
    });
    jwtSecretParam.grantRead(postInsights);
    tenantsTable.table.grantReadData(postInsights);
    longformIndex.table.grantReadData(postInsights);
    postAnalytics.table.grantReadData(postInsights);
    siteBucket.grantRead(postInsights, "*/index.html");
    postInsights.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [`${apInboundPostsTable.tableArn}/index/byPublished`],
    }));

    postInsights.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
      resources: [postAnalytics.table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["REPLY_STATE#*", "REPLY_SEND#*"] } },
    }));
    postInsights.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"], resources: [postAnalytics.table.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SITE_SHARING#*"] } },
    }));
    postInsights.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [apInboundPostsTable.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["*#article-replies"] } },
    }));
    postInsights.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [apInboundPostsTable.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["bluesky-only#*"] } },
    }));

    const replyPath = "/auth/insights/articles/{rkey}/replies";
    const sharingPath = "/auth/insights/sharing";
    const insightsIntegration = new apigwv2Integrations.HttpLambdaIntegration("PostInsightsIntegration", postInsights);
    for (const path of [
      "/auth/insights", "/auth/insights/overview", "/auth/insights/articles", "/auth/insights/articles/{rkey}", "/auth/insights/articles/{rkey}/distribution",
      replyPath, "/auth/insights/replies", sharingPath,
    ]) {
      const methods = path === replyPath || path === sharingPath
        ? [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] : [apigwv2.HttpMethod.GET];
      authHttpApi.addRoutes({ path, methods, integration: insightsIntegration });
    }

    const analyticsAggregate = new lambda.NodejsFunction(
      this,
      "AnalyticsAggregate",
      {
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(120),
        memorySize: 512,
        // Idempotent (PROCESSED# conditional-put) but bounded: S3 delivers
        // logs in batches; cap concurrency to protect cost at single-author
        // scale (mirrors longformRenderer's bounded-reserved-concurrency idiom).
        reservedConcurrentExecutions: 2,
        environment: {
          ...lambdaDefaults.environment,
          POST_ANALYTICS_TABLE: postAnalytics.table.tableName,
          ...(props.analyticsExcludeCidrs?.length
            ? { ANALYTICS_EXCLUDE_CIDRS: props.analyticsExcludeCidrs.join(",") } : {}),
        },
        ...lambdaSource("analytics/aggregate"),
      }
    );

    // Scoped analytics IAM (least-privilege, additive): the aggregator READS
    // delivered CloudFront logs and READ/WRITES the rollup table. NO Route53,
    // NO other resource.
    analyticsLogsBucket.grantRead(analyticsAggregate);
    postAnalytics.table.grantReadWriteData(analyticsAggregate);

    // S3-ObjectCreated → aggregator, scoped to the `cf/` standard-log prefix.
    analyticsLogsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(analyticsAggregate),
      { prefix: "cf/" }
    );

    // Additive scoped grant for the Task-4 admin analytics READ route on the
    // EXISTING xrpc/PDS handler (mirrors the Spec-#5 jti-table grant pattern:
    // narrowest sufficient grant, this one table only — READ only, NO write,
    // NO Route53, NO new Lambda/resource). The handler also gets the table
    // NAME in its env so the additive read `case` can resolve it.
    postAnalytics.table.grantReadData(xrpcHandler);
    xrpcHandler.addEnvironment(
      "POST_ANALYTICS_TABLE",
      postAnalytics.table.tableName
    );
    // Same allowlist the AP handlers use, so the analytics reader can sum the
    // per-host VIEW#<host>#<slug> partitions when no ?host= is passed.
    xrpcHandler.addEnvironment("AP_CUSTOM_HOSTS", KNOWN_TENANT_HOSTS);

    // -------------------------------------------------------------------
    // Spec #9 v2 — MCP engagement analytics
    // -------------------------------------------------------------------
    // get_engagement_trends reads the engagement/account time-series from the
    // SAME PostAnalyticsTable (READ only — narrowest grant, no write).
    postAnalytics.table.grantReadData(mcpHandler);
    mcpHandler.addEnvironment(
      "POST_ANALYTICS_TABLE",
      postAnalytics.table.tableName
    );
    // get_page_views also reads the longform index (READ only) so that only
    // slugs of real published posts count as post views.
    longformIndex.table.grantReadData(mcpHandler);
    mcpHandler.addEnvironment(
      "LONGFORM_INDEX_TABLE",
      longformIndex.table.tableName
    );

    // Daily snapshot capture: reuses the public-AppView readers
    // (readEngagement/readProfile) → writes ENGAGE#<uri>/<day> + ACCT#<did>/<day>
    // rows that finally populate the dormant Spec-#8 time-series. READ-ONLY
    // against the public AppView; the only writes are our own aggregate rows.
    // reservedConcurrency:1 (single-author cost bound). Apex byte-lock untouched
    // (no PDS code path; additive Lambda + EventBridge rule only).
    const captureEngagement = new lambda.NodejsFunction(
      this,
      "CaptureEngagement",
      {
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(120),
        memorySize: 512,
        reservedConcurrentExecutions: 1,
        environment: {
          ...lambdaDefaults.environment,
          POST_ANALYTICS_TABLE: postAnalytics.table.tableName,
          TENANTS_TABLE: tenantsTable.table.tableName,
          APEX_DID: `did:web:${DOMAIN}`,
        },
        ...lambdaSource("analytics/capture-engagement"),
      }
    );
    postAnalytics.table.grantReadWriteData(captureEngagement);
    tenantsTable.table.grantReadData(captureEngagement);

    // Daily at 09:00 UTC. Absolute last-write-wins snapshots, so the exact time
    // isn't load-bearing; one run/day keeps the series + cost minimal.
    new events.Rule(this, "CaptureEngagementSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "9" }),
      targets: [new targets.LambdaFunction(captureEngagement)],
    });

    // -------------------------------------------------------------------
    // Ops hardening — Lambda error alarms (additive only). Follows the
    // existing ApDeliveryErrors/LongformRendererErrors idiom: observability
    // only, NO SNS/alarm action wired (no SNS topic exists anywhere in this
    // stack to attach to — matching, not regressing, the current pattern).
    // Threshold is >=5 errors within a single 5-minute period (vs the
    // 1-error-in-15-minutes threshold used for the lower-volume AP/longform
    // background pipelines) because these seven Lambdas sit directly in the
    // live auth/XRPC/OAuth/MCP request path and see much higher baseline
    // traffic — a single transient error shouldn't page, but a burst of
    // >=5 in 5 minutes is a real signal worth surfacing.
    // -------------------------------------------------------------------
    const errorBurstAlarm = (id: string, fn: lambda.NodejsFunction) =>
      new cloudwatch.Alarm(this, id, {
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    errorBurstAlarm("XrpcHandlerErrors", xrpcHandler);
    errorBurstAlarm("AuthRequestHandlerErrors", requestMagicLinkHandler);
    errorBurstAlarm("AuthVerifyHandlerErrors", verifyMagicLinkHandler);
    errorBurstAlarm("AuthMeHandlerErrors", meHandler);
    errorBurstAlarm("OAuthHandlerErrors", oauthHandler);
    errorBurstAlarm("AtprotoOAuthHandlerErrors", atprotoOAuthHandler);
    errorBurstAlarm("McpHandlerErrors", mcpHandler);

    // -------------------------------------------------------------------
    // HSTS / security response headers (additive only, shared across both
    // site distributions). Deliberately does NOT set frameOptions/
    // frame-ancestors — MCP widgets and the OAuth flows may need to be
    // framed. Deliberately NOT attached to apiBehaviorApex/apiBehaviorMartzmakes
    // (their existing
    // CORS_ALLOW_ALL_ORIGINS ResponseHeadersPolicy is untouched) — only the
    // defaultBehavior on each distribution serves site HTML; every
    // additionalBehaviors entry on both distributions proxies to the API/
    // XRPC/OAuth/MCP Lambda origin, not HTML, so this policy is intentionally
    // scoped to defaultBehavior only.
    // -------------------------------------------------------------------
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeadersPolicy",
      {
        comment:
          "HSTS + nosniff + referrer-policy for HTML-serving default behaviors (no frame-options: MCP widgets/OAuth may be framed)",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: false,
            override: true,
          },
          contentTypeOptions: { override: true },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
      }
    );

    // One S3 origin instance per distribution, shared by its default behavior
    // and its '/auth/complete' SPA-shell behavior so CloudFront sees ONE origin.
    const apexSiteOrigin =
      cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    const spaShellBehavior = (origin: cloudfront.IOrigin): cloudfront.BehaviorOptions => ({
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: securityHeadersPolicy,
      functionAssociations: [
        {
          function: longformEdgeFn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
      edgeLambdas: [
        {
          functionVersion: notFoundEdgeFn.currentVersion,
          eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        },
      ],
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      // Post-analytics standard logging (Spec #8 / Phase E — ADDITIVE,
      // orthogonal). Adding enableLogging/logBucket/logFilePrefix injects ONLY
      // a `Logging` block into the synthesized DistributionConfig — it changes
      // NO behavior/origin/edge-fn/alias/cert. The apex serving config stays
      // byte-identical (G2 synth gate). Nothing else about this distribution
      // is touched.
      enableLogging: true,
      logBucket: analyticsLogsBucket,
      logFilePrefix: "cf/",
      defaultBehavior: {
        origin: apexSiteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
        functionAssociations: [{
          function: longformEdgeFn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
        edgeLambdas: [{
          functionVersion: notFoundEdgeFn.currentVersion,
          eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        }],
      },
      additionalBehaviors: {
        // Post-sign-in landing page. There is no API route for it (verify.ts
        // redirects to <site>/auth/complete?jwt=...); it used to work only
        // because the API's 404 was rewritten to the SPA shell by the removed
        // custom error responses. Serve the shell from S3 explicitly. MUST stay
        // ahead of '/auth/*'.
        "/auth/complete": spaShellBehavior(apexSiteOrigin),
        // Apex distribution — every api-path behavior below uses
        // apiBehaviorApex (customHeaders 'x-pds-viewer-host: serverless.social')
        // so the origin Lambda can tell it's serving the apex host now that
        // ALL_VIEWER_EXCEPT_HOST_HEADER strips the real Host header.
        "/mcp": apiBehaviorApex,
        "/mcp/*": apiBehaviorApex,
        "/auth/*": apiBehaviorApex,
        // AT Protocol OAuth — exact canonical metadata paths + /oauth/atproto/*.
        // CloudFront evaluates cache behaviors IN LIST ORDER, first match wins
        // (NOT most-specific). These exact /.well-known/* paths MUST precede the
        // '/.well-known/*' wildcard below, otherwise the wildcard would match
        // first — same precedence trick as subscribeRepos before '/xrpc/*'.
        // They all proxy to the same API-GW origin (apiBehaviorApex) as the
        // other /oauth/* + /.well-known/* behaviors; the HTTP API route fans
        // the request to the correct Lambda (AtprotoOAuthHandler vs OAuthHandler).
        "/.well-known/oauth-authorization-server": apiBehaviorApex,
        "/.well-known/oauth-protected-resource": apiBehaviorApex,
        // ActivityPub bridge (Spec #7 / Phase C — ADDITIVE). Same first-match
        // precedence trick as the oauth exacts above: CloudFront evaluates
        // cache behaviors IN LIST ORDER (NOT most-specific), and CDK preserves
        // additionalBehaviors object-key insertion order in the synthesized
        // CacheBehaviors array. So the EXACT '/.well-known/webfinger' MUST be
        // declared BEFORE the '/.well-known/*' wildcard below — otherwise the
        // wildcard would match webfinger first and fan it to the AT/OAuth
        // Lambdas instead of ApHandler. '/ap/*' is also placed before
        // '/.well-known/*' (and, being an additionalBehavior, is by
        // construction ahead of the longform DEFAULT behavior, which
        // CloudFront always evaluates last). Both reuse the existing
        // apiBehaviorApex (HTTP API origin); the HTTP API route fans the
        // request to ApHandler. Guarded by test/ap/apex-nonregression.test.ts G2(b).
        "/.well-known/webfinger": apiBehaviorApex,
        "/ap/*": apiBehaviorApex,
        "/oauth/atproto/*": apiBehaviorApex,
        "/oauth/*": apiBehaviorApex,
        "/.well-known/*": apiBehaviorApex,
        // Task 5 — Exact path for the AT Protocol firehose WebSocket subscription.
        // CloudFront evaluates cache behaviors IN LIST ORDER, first match wins —
        // it does NOT prefer the most-specific pattern. So this exact path MUST be
        // declared BEFORE the '/xrpc/*' wildcard, otherwise '/xrpc/*' would match
        // first and route the firehose to the HTTP API (501). CDK preserves the
        // insertion order of additionalBehaviors object keys when synthesizing
        // CacheBehaviors, so key order here is load-bearing.
        // WS clients (sending Upgrade: websocket) are transparently upgraded by
        // CloudFront to the FirehoseBox origin (firehoseBoxOrigin). wsBehavior is
        // shared/unmodified — out of scope for the x-pds-viewer-host change
        // (different header, different purpose).
        "/xrpc/com.atproto.sync.subscribeRepos": wsBehavior,
        // PDS XRPC — proxied through same CloudFront distribution so
        // did:web:serverless.social resolves correctly from the apex domain.
        // Binary CAR responses pass through without special CF config because
        // CloudFront forwards the response body + content-type verbatim and
        // APIGW HTTP API handles binary via isBase64Encoded in the Lambda response.
        "/xrpc/*": apiBehaviorApex,
      },
      defaultRootObject: "index.html",
      domainNames: [DOMAIN],
      certificate,
      // No custom errorResponses: the old 403/404 -> /index.html (200) fallback
      // masked API errors. SPA routes are rewritten to the shell by
      // longform-edge.js; S3 misses become real 404s via NotFoundEdgeFn.
    });

    new route53.ARecord(this, "ApexAliasRecord", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
    });

    const deploySite = new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(props.webAssetDirectory)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      // keep render-on-write longform objects; Expo assets are content-hashed
      prune: false,
    });

    // -------------------------------------------------------------------
    if (secondarySite) {
      const secondaryApiOrigin = new cloudfrontOrigins.HttpOrigin(apiOriginHost, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: { "x-pds-viewer-host": secondarySite.domain },
      });
      const secondaryApiBehavior = {
        origin: secondaryApiOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      };

      const secondaryZone = route53.HostedZone.fromLookup(
        this,
        `${secondarySite.constructIdPrefix}Zone`,
        { domainName: secondarySite.domain }
      );

      const secondaryCertificate = new acm.Certificate(
        this,
        `${secondarySite.constructIdPrefix}Certificate`,
        {
          domainName: secondarySite.domain,
          subjectAlternativeNames: [`www.${secondarySite.domain}`],
          validation: acm.CertificateValidation.fromDns(secondaryZone),
        }
      );

      const secondarySiteOrigin =
        cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(siteBucket);
      const secondaryDistribution = new cloudfront.Distribution(
        this,
        `${secondarySite.constructIdPrefix}Distribution`,
        {
          // Access-logging parity with the apex SiteDistribution (ops-hardening,
          // additive-only): SAME analytics logs bucket, SAME "cf/" prefix. The
          // existing S3 OBJECT_CREATED notification on analyticsLogsBucket is
          // already scoped to the "cf/" prefix (not to a specific distribution),
          // and AnalyticsAggregate parses each delivered log file by its
          // request-path/slug content, not by distribution ID — so reusing the
          // identical prefix means the SAME notification + aggregator Lambda
          // picks up martzmakes.com pageviews with no additional wiring.
          // CloudFront's delivered log filenames already embed the
          // distribution ID + a random hash, so two distributions logging to
          // the same prefix cannot collide.
          enableLogging: true,
          logBucket: analyticsLogsBucket,
          logFilePrefix: "cf/",
          // SAME default S3 origin construct/pattern + SAME shared host-aware
          // longform viewer-request Function as the apex SiteDistribution. We do
          // NOT duplicate the S3 bucket or the CloudFront Function resource — the
          // existing `siteBucket` + `longformEdgeFn` are reused (associating the
          // SAME Function on a 2nd distribution is supported; CloudFront Functions
          // are account-level resources associable to multiple distributions).
          defaultBehavior: {
            origin: secondarySiteOrigin,
            viewerProtocolPolicy:
              cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            // Same shared HSTS/security-headers policy as the apex
            // SiteDistribution's defaultBehavior — this distribution also
            // serves site HTML off the same S3 origin.
            responseHeadersPolicy: securityHeadersPolicy,
            functionAssociations: [
              {
                function: longformEdgeFn,
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              },
            ],
            edgeLambdas: [
              {
                functionVersion: notFoundEdgeFn.currentVersion,
                eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
              },
            ],
          },
          // Mirror the apex distribution's behavior set so platform routes still
          // resolve under the martzmakes host (SAME wsBehavior config object +
          // same key insertion order — CloudFront evaluates behaviors by list
          // order, first match wins), but with secondaryApiBehavior
          // (customHeaders 'x-pds-viewer-host: martzmakes.com') instead of the
          // apex's apiBehaviorApex, so the origin Lambda can tell which host a
          // request actually arrived on now that ALL_VIEWER_EXCEPT_HOST_HEADER
          // strips the real Host header. Applies to this distribution's
          // martzmakes.com AND www.martzmakes.com aliases alike (both are
          // domainNames on this one distribution, not separate behaviors).
          additionalBehaviors: {
            // See the apex distribution: /auth/complete is an SPA route served
            // from S3 (shell chosen by longform-edge.js), ahead of '/auth/*'.
            "/auth/complete": spaShellBehavior(secondarySiteOrigin),
            "/mcp": secondaryApiBehavior,
            "/mcp/*": secondaryApiBehavior,
            "/auth/*": secondaryApiBehavior,
            "/.well-known/oauth-authorization-server": secondaryApiBehavior,
            "/.well-known/oauth-protected-resource": secondaryApiBehavior,
            "/.well-known/webfinger": secondaryApiBehavior,
            "/ap/*": secondaryApiBehavior,
            "/oauth/atproto/*": secondaryApiBehavior,
            "/oauth/*": secondaryApiBehavior,
            "/.well-known/*": secondaryApiBehavior,
            "/xrpc/com.atproto.sync.subscribeRepos": wsBehavior,
            "/xrpc/*": secondaryApiBehavior,
          },
          defaultRootObject: "index.html",
          domainNames: [secondarySite.domain, `www.${secondarySite.domain}`],
          certificate: secondaryCertificate,
          // No custom errorResponses (see the apex distribution).
        }
      );

      // Surfaced for the Task 12 DNS cutover (the ARecord/AaaaRecord aliasing
      // martzmakes.com / www at this distribution is created THERE, not here).
      new cdk.CfnOutput(this, `${secondarySite.constructIdPrefix}DistributionDomainName`, {
        value: secondaryDistribution.distributionDomainName,
        description:
          "martzmakes.com blog CloudFront distribution domain (Task 12 DNS cutover target)",
      });

      // CDK `BucketDeployment` only invalidates ONE distribution. The Expo SPA
      // bundle lives in the SAME S3 origin for apex (SiteDistribution) AND
      // martzmakes (MartzmakesDistribution); without an explicit invalidation
      // here, the martzmakes edge cache serves a STALE `/index.html` referencing
      // the previous bundle hash after a deploy (root cause of the 5c "I see
      // serverless.social, not my martzmakes content" report — the edge held the
      // pre-fix bundle). Invalidate `/*` on MartzmakesDistribution on every
      // deploy, after DeploySite finishes uploading.
      const secondaryInvalidation = new cr.AwsCustomResource(
        this,
        `${secondarySite.constructIdPrefix}Invalidation`,
        {
          onUpdate: {
            service: "CloudFront",
            action: "createInvalidation",
            parameters: {
              DistributionId: secondaryDistribution.distributionId,
              InvalidationBatch: {
                CallerReference: `mm-inv-${Date.now()}`,
                Paths: { Quantity: 1, Items: ["/*"] },
              },
            },
            physicalResourceId: cr.PhysicalResourceId.of(
              `${secondarySite.constructIdPrefix}Invalidation-${Date.now()}`,
            ),
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
              actions: ["cloudfront:CreateInvalidation"],
              resources: ["*"],
            }),
          ]),
        },
      );
      secondaryInvalidation.node.addDependency(deploySite);
    }

    // SES sending identity (EasyDKIM auto-creates CNAMEs in the hosted zone)
    const sesIdentity = new ses.EmailIdentity(this, "SesEmailIdentity", {
      identity: ses.Identity.publicHostedZone(hostedZone),
      dkimIdentity: ses.DkimIdentity.easyDkim(),
    });

    // Grant ManageConnections so both Lambdas can post back to WS clients.
    firehoseWs.grantManageConnections(firehoseWsHandler);
    firehoseWs.grantManageConnections(firehoseFanoutHandler);

    // Task 4 (additive): wire the RepoTable DDB stream to the fanout Lambda.
    // WS management endpoint for postToConnection.
    //
    // CRITICAL: firehoseWs.api.apiEndpoint returns a `wss://` URL for a
    // WebSocket API. The ApiGatewayManagementApiClient makes HTTPS API calls
    // (it is a control-plane client, not a WS client) — passing a `wss://`
    // endpoint makes every postToConnection fail with ECONNREFUSED, which
    // silently dropped EVERY firehose frame (replay + live fan-out). The
    // management endpoint MUST be the `https://` execute-api URL:
    //   https://<wsApiId>.execute-api.<region>.amazonaws.com/<stageName>
    const wsMgmtEndpoint = `https://${firehoseWs.api.apiId}.execute-api.${this.region}.amazonaws.com/${firehoseWs.stage.stageName}`;
    firehoseFanoutHandler.addEnvironment("WS_MGMT_ENDPOINT", wsMgmtEndpoint);

    firehoseFanoutHandler.addEventSource(
      new DynamoEventSource(repoTable.table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 2,
        bisectBatchOnError: true,
      })
    );

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------
    new cdk.CfnOutput(this, "PublicBaseUrl", {
      value: `https://${DOMAIN}`,
      description: "Public base URL (CloudFront-fronted, API + static)",
    });
    new cdk.CfnOutput(this, "AuthHttpApiDirectUrl", {
      value: authHttpApi.apiEndpoint,
      description: "Direct API Gateway URL (for debugging only)",
    });
    new cdk.CfnOutput(this, "McpUrl", {
      value: `https://${DOMAIN}/mcp`,
      description: "MCP server URL — paste into Claude Desktop connectors",
    });
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "CloudFront URL (redirects to apex domain)",
    });
    new cdk.CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, "UsersTableName", { value: usersTable.tableName });
    new cdk.CfnOutput(this, "MagicLinkTokensTableName", {
      value: magicLinkTokensTable.tableName,
    });
    new cdk.CfnOutput(this, "OAuthTableName", { value: oauthTable.tableName });
    new cdk.CfnOutput(this, "WaitlistTableName", {
      value: waitlistTable.tableName,
      description: "DynamoDB table capturing waitlist signups (pk=email)",
    });
    new cdk.CfnOutput(this, "SesEmailIdentityName", {
      value: sesIdentity.emailIdentityName,
    });
    new cdk.CfnOutput(this, "PdsDid", {
      value: `did:web:${DOMAIN}`,
      description: "AT Protocol DID for this PDS (did:web)",
    });
    new cdk.CfnOutput(this, "PdsEndpoint", {
      value: `https://${DOMAIN}`,
      description: "AT Protocol PDS endpoint (apex domain)",
    });
    new cdk.CfnOutput(this, "RepoTableName", {
      value: repoTable.table.tableName,
      description: "DynamoDB table backing the AT Protocol repo",
    });
    new cdk.CfnOutput(this, "TenantsTableName", {
      value: tenantsTable.table.tableName,
      description: "DynamoDB table backing the sub-user tenant registry",
    });
    new cdk.CfnOutput(this, "BlobBucketName", {
      value: blobBucket.bucketName,
      description: "S3 bucket backing the AT Protocol blob store",
    });
    // Echoes the handle this stack was deployed with. Useful for confirming
    // a multi-instance deploy used the right -c pdsHandle=<domain> value.
    new cdk.CfnOutput(this, "PdsHandle", {
      value: pdsHandle,
      description: "AT Protocol PDS handle configured for this deployment (from CDK context pdsHandle)",
    });
    new cdk.CfnOutput(this, "FirehoseWsUrl", {
      value: firehoseWs.stage.url,
      description: "WebSocket URL for AT Protocol subscribeRepos firehose (wss://)",
    });

    new cdk.CfnOutput(this, "PostAnalyticsTableName", {
      value: postAnalytics.table.tableName,
      description: "DynamoDB table backing post-analytics rollups (Spec #8)",
    });

    if (firehoseBox) {
      new cdk.CfnOutput(this, "FirehoseBoxIpv6", {
        value: firehoseBox.ipv6Address,
        description: "IPv6 address of the firehose box (it has no public IPv4)",
      });
    }
    new cdk.CfnOutput(this, "FirehoseBoxDomain", {
      value: firehoseHostname,
      description: "Firehose box public domain (firehose.serverless.social)",
    });

    // -------------------------------------------------------------------
    // Alarm notifications. One SNS topic; the email comes from CDK context
    // `alarmEmail` (set in cdk.json because CI deploys with no -c flags).
    // An Aspect attaches the topic to EVERY cloudwatch.Alarm in the stack,
    // including ones inside nested constructs (FirehoseBox) and any alarm
    // added in future, so none can silently miss a notification. Existing
    // actions (the firehose EC2 recover) are kept; this only adds.
    // -------------------------------------------------------------------
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: "Serverless Social alarms",
    });
    const alarmEmail = props.alarmEmail;
    if (typeof alarmEmail === "string" && alarmEmail.length > 0) {
      alarmTopic.addSubscription(new subs.EmailSubscription(alarmEmail));
    }
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    cdk.Aspects.of(this).add({
      visit(node) {
        if (node instanceof cloudwatch.Alarm) {
          node.addAlarmAction(alarmAction);
        }
      },
    });
  }
}
