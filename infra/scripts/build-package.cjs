const { copyFile, mkdir, readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { build } = require("esbuild");
const { buildFirehose } = require("../firehose-box/build.js");
const { writeBundledNotices } = require("./bundled-notices.cjs");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

async function main() {
  await rm(dist, { recursive: true, force: true });
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"),
    "--project", "tsconfig.package.json",
  ], { cwd: root, stdio: "inherit" });

  const { lambdaEntries } = require("../dist/lib/lambda-assets");
  const lambdas = await Promise.all(lambdaEntries.map(entry =>
    build({
      absWorkingDir: root,
      entryPoints: [`lib/lambdas/${entry}.ts`],
      outfile: path.join(dist, "lambda-assets", entry, "index.js"),
      platform: "node",
      target: "node22",
      format: "cjs",
      bundle: true,
      minify: true,
      sourcemap: true,
      metafile: true,
    })
  ));

  const bootstrap = await build({
    absWorkingDir: root,
    stdin: {
      contents: (await readFile(path.join(root, "scripts/pds-bootstrap.ts"), "utf8")).replace(/^#![^\n]*\n/, ""),
      resolveDir: path.join(root, "scripts"),
      loader: "ts",
    },
    outfile: path.join(dist, "pds-bootstrap.cjs"),
    platform: "node",
    target: "node22",
    format: "cjs",
    banner: { js: "#!/usr/bin/env node" },
    bundle: true,
    minify: true,
    metafile: true,
  });

  for (const file of ["longform-edge.js", "not-found-edge.js"]) {
    await copyFile(path.join(root, "lib", file), path.join(dist, "lib", file));
  }

  const box = path.join(dist, "firehose-box");
  await mkdir(path.join(box, "dist"), { recursive: true });
  for (const file of ["Caddyfile", "package.json", "user-data.sh"]) {
    await copyFile(path.join(root, "firehose-box", file), path.join(box, file));
  }
  const firehose = await buildFirehose(path.join(box, "dist/server.bundle.cjs"));
  await copyFile(path.join(root, "firehose-box/package-lock.json"), path.join(box, "npm-shrinkwrap.json"));
  await writeBundledNotices(path.join(dist, "THIRD_PARTY_NOTICES.txt"), [
    ...[...lambdas, bootstrap].map(result => ({ base: root, metafile: result.metafile })),
    { base: path.join(root, "firehose-box"), metafile: firehose.metafile },
  ]);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
