const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "serverless-social-package-"));

try {
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--pack-destination", workspace,
  ], { cwd: packageRoot, encoding: "utf8" }))[0];
  const paths = new Set(packed.files.map(file => file.path));
  assert.ok(paths.has("LICENSE"), "The tarball includes the project license");
  assert.ok(paths.has("dist/THIRD_PARTY_NOTICES.txt"), "The tarball includes bundled notices");
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ private: true }));
  execFileSync("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    path.join(workspace, packed.filename),
    `aws-cdk-lib@${require("aws-cdk-lib/package.json").version}`,
    `constructs@${require("constructs/package.json").version}`,
  ], { cwd: workspace, stdio: "inherit" });

  fs.copyFileSync(path.join(__dirname, "package-consumer.cjs"), path.join(workspace, "app.cjs"));
  execFileSync(process.execPath, ["app.cjs"], { cwd: workspace, stdio: "inherit" });
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
