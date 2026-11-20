const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { App, Stack } = require("aws-cdk-lib");
const { HostedZone } = require("aws-cdk-lib/aws-route53");
const { ServerlessSocialStack, ServerlessSocialSite } = require("@martzmakes/serverless-social");
const { ArticleReplyQueue } = require("@martzmakes/serverless-social/insights-web");
const { createInsightsClient } = require("@martzmakes/serverless-social/insights");
assert.equal(typeof ArticleReplyQueue, "function");
assert.equal(typeof createInsightsClient({ origin: "https://social.example.com", token: () => null }).replyQueue, "function");

const env = { account: "123456789012", region: "us-east-1" };
const context = {
  "availability-zones:account=123456789012:region=us-east-1": ["us-east-1a"],
  "ssm:account=123456789012:parameterName=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64:region=us-east-1": "ami-00000000000000001",
};
const app = new App({ context, outdir: path.resolve("cdk.out") });
const web = path.resolve("web");
fs.mkdirSync(web);
fs.writeFileSync(path.join(web, "index.html"), "<title>Test site</title>");
const props = {
  env,
  domain: "social.example.com",
  projectSlug: "example-social",
  siteName: "Example Social",
  adminEmail: "admin@example.com",
  hostedZoneId: "Z123456789",
  webAssetDirectory: web,
};
new ServerlessSocialStack(app, "Standalone", props);
new ServerlessSocialStack(app, "ExistingFirehose", {
  ...props,
  firehose: { mode: "existing", hostname: "firehose.example.com", instanceId: "example-repo" },
});
new ServerlessSocialStack(app, "Editor", {
  ...props, editor: true,
  firehose: { mode: "existing", hostname: "firehose.example.com", instanceId: "editor-test" },
});
const site = new Stack(app, "ExistingPds", { env });
new ServerlessSocialSite(site, "Site", {
  domain: "example.net",
  hostedZone: HostedZone.fromHostedZoneAttributes(site, "Zone", {
    hostedZoneId: "Z123456780",
    zoneName: "example.net",
  }),
  webAssetDirectory: web,
  pds: { hostname: props.domain, apiHostname: "api.example.com" },
});
const assembly = app.synth();
assert.deepEqual(app.node.tryGetContext("missing"), undefined);

const resources = (stack, type) => Object.values(assembly.getStackByName(stack).template.Resources)
  .filter(resource => resource.Type === type).map(resource => resource.Properties);
const distribution = stack => resources(stack, "AWS::CloudFront::Distribution")[0].DistributionConfig;
const originFor = (dist, route) => dist.Origins.find(
  origin => origin.Id === dist.CacheBehaviors.find(behavior => behavior.PathPattern === route).TargetOriginId,
);
const stream = "/xrpc/com.atproto.sync.subscribeRepos";

const authMe = Object.entries(assembly.getStackByName("Standalone").template.Resources)
  .find(([id, resource]) => id.startsWith("AuthMeHandler") && resource.Type === "AWS::Lambda::Function");
assert.equal(authMe?.[1].Properties.Environment.Variables.PDS_HANDLE, props.domain);
assert.equal(resources("Standalone", "AWS::EC2::Instance").length, 1);
const registry = resources("Standalone", "AWS::SSM::Parameter")
  .find(parameter => parameter.Name === "/example-social/firehose-registry");
assert.ok(registry, "Standalone stack creates its own registry");
assert.equal(originFor(distribution("Standalone"), stream).DomainName, "firehose.social.example.com");
const firehoseAsset = fs.readdirSync(assembly.directory)
  .filter(name => name.startsWith("asset."))
  .map(name => path.join(assembly.directory, name))
  .find(dir => fs.existsSync(path.join(dir, "Caddyfile")));
assert.ok(firehoseAsset, "Packaged firehose assets stage during synth");
assert.ok(fs.existsSync(path.join(firehoseAsset, "npm-shrinkwrap.json")));
assert.ok(fs.existsSync(path.join(firehoseAsset, "dist", "server.bundle.cjs")));
assert.ok(resources("Standalone", "AWS::Lambda::Function").filter(fn => fn.Handler === "index.handler").length >= 16);
assert.equal(resources("ExistingFirehose", "AWS::EC2::Instance").length, 0);
const editorTargets = resources("Editor", "AWS::ApiGatewayV2::Route").map(route => route.RouteKey);
assert.ok(editorTargets.includes("GET /auth/editor"));
assert.ok(editorTargets.includes("PUT /auth/editor/{proxy+}"));
assert.equal(resources("Editor", "AWS::Scheduler::ScheduleGroup").length, 1);
assert.equal(resources("Editor", "AWS::EC2::Instance").length, 0);
assert.equal(resources("Standalone", "AWS::Scheduler::ScheduleGroup").length, 0);
assert.ok(require("@martzmakes/serverless-social/editor").createEditorClient);
assert.ok(require.resolve("@martzmakes/serverless-social/editor-web"));
assert.ok(require("@martzmakes/serverless-social/insights").createInsightsClient);
assert.ok(require.resolve("@martzmakes/serverless-social/insights-web"));
for (const route of ["/auth/insights", "/auth/insights/articles", "/auth/insights/articles/{rkey}", "/auth/insights/articles/{rkey}/distribution", "/auth/insights/articles/{rkey}/replies"]) {
  assert.ok(resources("Standalone", "AWS::ApiGatewayV2::Route").some(item => item.RouteKey === `GET ${route}`));
}
assert.ok(resources("Standalone", "AWS::ApiGatewayV2::Route").some(item =>
  item.RouteKey === "POST /auth/insights/articles/{rkey}/replies"));
const existingOrigin = originFor(distribution("ExistingFirehose"), stream);
assert.equal(existingOrigin.DomainName, "firehose.example.com");
assert.deepEqual(existingOrigin.OriginCustomHeaders, [
  { HeaderName: "X-PDS-Instance", HeaderValue: "example-repo" },
]);
assert.equal(resources("ExistingPds", "AWS::DynamoDB::Table").length, 0);
assert.equal(resources("ExistingPds", "AWS::EC2::Instance").length, 0);
const attached = distribution("ExistingPds");
assert.equal(originFor(attached, stream).DomainName, "social.example.com");
const apiOrigin = originFor(attached, "/xrpc/*");
assert.equal(apiOrigin.DomainName, "api.example.com");
assert.deepEqual(apiOrigin.OriginCustomHeaders, [
  { HeaderName: "x-pds-viewer-host", HeaderValue: "example.net" },
]);
const router = resources("ExistingPds", "AWS::CloudFront::Function")[0].FunctionCode;
for (const [uri, expected] of [["/profile/admin", "/index.html"], ["/auth/complete", "/index.html"], ["/assets/logo.png", "/assets/logo.png"]]) {
  const event = { request: { uri } };
  assert.equal(vm.runInNewContext(`${router}\nhandler(event)`, { event }).uri, expected);
}
console.log("Synthesized standalone, existing firehose, and existing PDS from the installed tarball.");
