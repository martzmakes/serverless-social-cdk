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

After `cdk deploy`, verify SES DKIM and production sending access. Initialize the repository from the AWS environment that owns the stack. Set `REPO_TABLE` to the physical table name in the stack’s `RepoTableName` output.

```sh
AWS_REGION=us-east-1 PDS_HANDLE=social.example.com PROJECT_SLUG=example-social \
  REPO_TABLE='your-physical-repo-table-name' npx --no-install serverless-social-bootstrap
```

Use the same domain and project slug on subsequent deployments.

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
import { App, Stack } from "aws-cdk-lib";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { resolve } from "node:path";
import { ServerlessSocialSite } from "@martzmakes/serverless-social";

const app = new App();
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

This construct deploys a static bundle and forwards app routes to the PDS. For a tenant on a Serverless Social backend, set `pds.apiHostname` to the direct backend hostname and include the site domain in the backend's `tenantHosts`. When both stacks are defined in one CDK app, pass the PDS stack's `apiHostname` directly. The public `pds.hostname` supplies the default WebSocket origin. The full UI uses Serverless Social's own auth and application routes. Static longform artifacts can be supplied with the site bundle. For shared render-on-write longform, configure a `secondarySite` on the backend stack so both distributions use the same bucket and renderer.

For staging, set `notifyOfUpdateTargets: []` on the PDS stack to suppress relay notifications while testing commits on its firehose.

## Add the web post editor

Set `editor: true` on `ServerlessSocialStack`. Sites attached to that backend use the same editor API, and each signed-in author can access drafts for the DIDs their session is entitled to edit. A site connected to an existing PDS can use the editor when the backend operator enables it.

The package exports the browser client and an optional React editor without loading the CDK in the browser:

```tsx
import { createEditorClient } from "@martzmakes/serverless-social/editor";
import { PostEditor } from "@martzmakes/serverless-social/editor-web";

// Create the client once per active identity.
const client = createEditorClient({
  origin: window.location.origin,
  did: activeDid,
  token: getStoredAppJwt,
});

<PostEditor client={client} identity={activeHandle} />;
```

The editor supports short posts and longform articles, autosave, image uploads, revocable unlisted previews, and revisions of published posts. The client uses the deployment's existing application JWT. Drafts and original uploads live in DynamoDB and private S3. Publishing promotes attached images and writes to the PDS, where the usual rendering and federation run. A revision leaves the currently published record visible until the revision is published. Recipients can save anything they can open via an unlisted preview link.

Scheduling uses one-time EventBridge Scheduler jobs and an SQS-triggered publisher. Scheduled times are stored in UTC. Scheduler delivers within the selected minute and publication follows queue processing. Canceled or replaced jobs are ignored when delivered. The draft table and media bucket are retained after stack deletion. Monitor the editor dead-letter queue for exhausted deliveries.

## Article link previews

Set `coverImage` on a published longform record to use that image in its Open Graph and X card. For PNG and JPEG covers stored as platform blobs, the renderer writes a 1200 × 630 JPEG to the site bucket and serves it from CloudFront. The article retains the original image. Set `coverImageAlt` to describe the cover or give the matching image in the Markdown body alt text. External cover URLs are included directly in the metadata.

To update generated pages for existing posts, build and run `infra/scripts/refresh-cover-previews.ts` with the tenant's site origin, PDS origin, DID, site bucket, and longform index table. Pass the tenant's S3 prefix for a secondary site. The default run lists affected pages. With `--apply` and a new `--backup-dir`, it backs up the original HTML and updates only its social tags. Invalidate the updated article paths in CloudFront after applying.

## Package verification

Run `npm run test:package` in this directory. It packs the library, installs the tarball in a fresh app, and synthesizes all three configurations using offline fixtures.

## License

The Serverless Social package source is available under the [MIT License](LICENSE). The npm tarball includes `dist/THIRD_PARTY_NOTICES.txt` with the licenses and notices for its bundled code. The notice list is regenerated from the actual bundle inputs each time the package is built.
