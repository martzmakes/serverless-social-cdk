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

## Add the publishing calendar

Pass your signed-in layout's origin and token provider to the calendar exported with the editor.

```tsx
import { PublishingCalendar } from "@martzmakes/serverless-social/editor-web";

<PublishingCalendar origin={window.location.origin} token={getStoredAppJwt}
  onOpen={(draft, did) => openDraftInYourEditor(did, draft.kind, draft.id)} />;
```

The calendar loads drafts and schedules for every approved publishing identity and displays schedules in the browser's local time. Opening a draft should pass its ID as `initialDraftId` to `PostEditor` with a client scoped to the selected DID. A cross-site copy creates a private unscheduled draft for another approved identity and copies its attached uploads. Choose a new URL slug, customize the copy, and schedule it separately in the destination editor.

## Add the post control room

The full `ServerlessSocialStack` includes article analytics for its primary and `secondarySite` CloudFront distributions. Both distributions deliver access logs to the existing private S3 bucket. A Lambda updates DynamoDB by viewer hostname, article slug, and UTC day. An authenticated read API serves reports only for publishing sites approved for the app session.

Mount the React view inside your signed-in layout and give it the same application JWT used by the rest of the site. The site picker defaults to the current hostname when the author has access to it.

```tsx
import { createInsightsClient } from "@martzmakes/serverless-social/insights";
import { PostInsights } from "@martzmakes/serverless-social/insights-web";

const client = createInsightsClient({
  origin: window.location.origin,
  token: getStoredAppJwt,
});

<PostInsights client={client} preferredHost={window.location.hostname} />;
```

The report counts page requests classified as human, grouped by day. It estimates mobile, tablet, desktop, and unknown device groups from the user agent. An allowlisted `utm_source` tag takes priority over the observed referrer. Share tagged links when an app may omit referrers. Without either signal the source is Direct or unavailable. CloudFront delivers logs asynchronously, so recent totals can change after a delay.

Existing per-site daily totals and referrer domains remain available. Source and device coverage starts when the updated aggregator processes logs. The rollup keeps counters and reduced referrer domains. Original access logs stay in the private bucket and expire after 30 days. The report uses the article's current canonical slug. It shows the latest saved Bluesky engagement snapshot when available, the Fediverse article object, and the Open Graph metadata from the published page. Open Article replies to read the Bluesky conversation alongside public and unlisted direct replies received over ActivityPub. Fediverse reply collection starts when the updated inbox handler is deployed and retains each reply for 90 days. The inbox lets an author send a reply from the selected publishing identity and mark a reply handled or reopen it. The handled state is private and shared across sites for that identity and article. Bluesky sends an AT Protocol reply with the original thread root and parent. Fediverse sends a signed ActivityPub reply to the commenter's instance, and transient failures use the existing delivery queue. A later Fediverse reply to one of the site's replies appears under the same article.

## Add article replies to the signed-in inbox

Import `ArticleReplyQueue` from `@martzmakes/serverless-social/insights-web` and render `<ArticleReplyQueue client={client} />` with the same authenticated insights client. The queue merges replies across approved sites and sorts loaded replies by reply time. Search matches the loaded reply text, author, and article title. The site and network filters apply to both Open and Handled. Undo reverses your last status change.

The queue loads up to eight index entries at a time per site. **Load older articles** adds conversations from earlier articles. **Older Mastodon replies** loads further pages of a busy Fediverse conversation. Each load uses the existing publication index, stored ActivityPub replies, and Bluesky App View. The queue reports partial results when a source is unavailable and needs no background polling.

## Configure cross-site sharing

Render `<SiteSharingSettings client={client} />` from `@martzmakes/serverless-social/insights-web` in the signed-in settings of each site. An owner can limit both the site's outgoing sharing and the content it accepts from each connected site. A direction is available only when the source allows outgoing sharing and the destination allows incoming sharing. Existing deployments start with both directions enabled. A session created before site-bound sign-in requires a new sign-in on the site to save settings.

The server checks site membership and sharing before listing or operating on another site's drafts, analytics, and article replies. Copying drafts requires both publishing identities and an allowed direction from source to destination. Public posts, federation, unlisted preview links, and copies already made keep their existing access rules.

## Article link previews

Set `coverImage` on a published longform record to use that image in its Open Graph and X card. For PNG and JPEG covers stored as platform blobs, the renderer writes a 1200 × 630 JPEG to the site bucket and serves it from CloudFront. The article retains the original image. Set `coverImageAlt` to describe the cover or give the matching image in the Markdown body alt text. External cover URLs are included directly in the metadata.

To update generated pages for existing posts, build and run `infra/scripts/refresh-cover-previews.ts` with the tenant's site origin, PDS origin, DID, site bucket, and longform index table. Pass the tenant's S3 prefix for a secondary site. The default run lists affected pages. With `--apply` and a new `--backup-dir`, it backs up the original HTML and updates only its social tags. Invalidate the updated article paths in CloudFront after applying.

## Package verification

Run `npm run test:package` in this directory. It packs the library, installs the tarball in a fresh app, and synthesizes all three configurations using offline fixtures.

## License

The Serverless Social package source is available under the [MIT License](LICENSE). The npm tarball includes `dist/THIRD_PARTY_NOTICES.txt` with the licenses and notices for its bundled code. The notice list is regenerated from the actual bundle inputs each time the package is built.
