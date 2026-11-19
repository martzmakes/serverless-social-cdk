# Serverless Social CDK

CDK v2 constructs for a DynamoDB-backed AT Protocol PDS, an optional shared firehose, and a site that connects to an existing PDS.

## Deploy a PDS and firehose

In a TypeScript CDK app, install the package:

```sh
npm install @martzmakes/serverless-social aws-cdk-lib constructs
```

```ts
import { App } from "aws-cdk-lib";
import { resolve } from "node:path";
import { ServerlessSocialStack } from "@martzmakes/serverless-social";

const app = new App();
new ServerlessSocialStack(app, "Social", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  domain: "social.example.com",
  projectSlug: "example-social",
  siteName: "Example Social",
  adminEmail: "admin@example.com",
  hostedZoneId: "Z123456789",
  webAssetDirectory: resolve("web"),
  terminationProtection: true,
});
```

Use a public Route 53 zone named for `domain`. Omit `hostedZoneId` to let CDK look it up. For a subdomain like `social.example.com`, create and delegate a hosted zone for that subdomain. Deploy in `us-east-1` for CloudFront certificates and Lambda@Edge.

The web directory is the caller's static build. Include `index.html`, `_shell/home.<domain>.html` and `_shell/robots.<domain>.txt`. The full stack uses the first file for SPA routes and the other two for the homepage and robots file.

Bootstrap the AWS environment and create these SSM SecureString parameters under the chosen `projectSlug` before deployment:

| Path suffix | Value |
| --- | --- |
| `/jwt-secret` | Random JWT signing secret, at least 32 bytes of entropy |
| `/atproto-signing-key` | Hex-encoded secp256k1 private key kept for this PDS identity |
| `/app-password` | Optional password for first-party XRPC `createSession` |

After `cdk deploy`, verify SES DKIM and production sending access. Initialize the repository from the AWS environment that owns the stack:

```sh
AWS_REGION=us-east-1 PDS_HANDLE=social.example.com PROJECT_SLUG=example-social \
  REPO_TABLE=<RepoTableName-output> npx --no-install serverless-social-bootstrap
``` Use the same domain and project slug on subsequent deployments.

## Reuse an existing firehose

Set this property on `ServerlessSocialStack`:

```ts
firehose: {
  mode: "existing",
  hostname: "firehose.example.com",
  instanceId: "social.example.com",
},
```

The existing box owner registers the instance ID, repo table and DID in the box's registry and gives its role read access to the table. Use the new stack's `RepoTableName` and `PdsDid` outputs. The current box resolves table names in its own AWS account and region. Restart its service after a registry update and check that the new origin streams the intended repository. Set `ipAddressType` to `OriginIpAddressType.IPV6` for an IPv6-only origin.

## Deploy a site against an existing PDS

```ts
import { Stack } from "aws-cdk-lib";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { ServerlessSocialSite } from "@martzmakes/serverless-social";

const siteStack = new Stack(app, "PersonalSite", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
});
const zone = HostedZone.fromLookup(siteStack, "Zone", { domainName: "example.net" });

new ServerlessSocialSite(siteStack, "Site", {
  domain: "example.net",
  hostedZone: zone,
  webAssetDirectory: resolve("web"),
  pds: { hostname: "social.example.com" },
});
```

This construct deploys a static bundle and forwards app routes to the PDS. For a tenant on a Serverless Social backend, set `pds.apiHostname` to the direct backend hostname and include the site domain in the backend's `tenantHosts`. The public `pds.hostname` supplies the default WebSocket origin. The full UI uses Serverless Social's own auth and application routes. Static longform artifacts can be supplied with the site bundle. For shared render-on-write longform, configure a `secondarySite` on the backend stack so both distributions use the same bucket and renderer.

## Package verification

Run `npm run test:package` in this directory. It packs the library, installs the tarball in a fresh app, and synthesizes all three configurations using offline fixtures.

## License

The Serverless Social package source is available under the [MIT License](LICENSE). The npm tarball includes `dist/THIRD_PARTY_NOTICES.txt` with the licenses and notices for its bundled code. The notice list is regenerated from the actual bundle inputs each time the package is built.
