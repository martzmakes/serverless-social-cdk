const { readFile, readdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const fallbackDirectory = path.join(__dirname, "../vendor-licenses");
const aws = ["aws-sdk-v3-LICENSE.txt"];
const upstreamFiles = new Map([
  ["@aws-sdk/credential-provider-http", aws],
  ["@aws-sdk/credential-provider-login", aws],
  ["@aws-sdk/nested-clients", aws],
  ["uint8arrays", ["uint8arrays-MIT.txt"]],
  ["varint", ["MIT.txt"]],
]);

function dependencyRoot(base, input) {
  const matches = [...input.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+(?=\/|$)/g)];
  const deepest = matches.at(-1);
  return deepest && path.resolve(base, input.slice(0, deepest.index + deepest[0].length));
}

async function packageNotice(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(file => file.isFile() && /^(licen[cs]e|copying|notice|third[-_]party)/i.test(file.name))
    .map(file => file.name)
    .sort();
  const fallback = Boolean(!files.length && upstreamFiles.has(manifest.name));
  const names = fallback ? upstreamFiles.get(manifest.name) : files;
  const base = fallback ? fallbackDirectory : directory;
  if (!names.length) throw new Error(`No license or notice file for ${manifest.name}@${manifest.version}`);
  const label = `${manifest.name}@${manifest.version}`;
  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
  const notices = await Promise.all(names.map(async name => (
    `[${name}]\n${(await readFile(path.join(base, name), "utf8")).trimEnd()}`
  )));
  return {
    label,
    text: `${label} (${manifest.license})\n${author ? `Author: ${author}\n` : ""}\n${notices.join("\n\n")}`,
  };
}

async function writeBundledNotices(destination, bundles) {
  const directories = new Set();
  for (const { base, metafile } of bundles) {
    for (const input of Object.keys(metafile.inputs)) {
      const directory = dependencyRoot(base, input);
      if (directory) directories.add(directory);
    }
  }
  const entries = await Promise.all([...directories].map(packageNotice));
  if (!entries.length) throw new Error("No bundled dependencies found for third-party notices");
  const notices = new Map(entries.map(entry => [entry.label, entry.text]));
  const sorted = [...notices].sort(([a], [b]) => a.localeCompare(b));
  const text = [
    "Serverless Social third-party notices",
    "This distribution includes code from the following packages. Their notices and license terms appear below.",
    ...sorted.map(([, notice]) => notice),
  ].join("\n\n================================================================================\n\n");
  await writeFile(destination, `${text}\n`);
  console.error(`Included notices for ${notices.size} bundled package versions.`);
}

module.exports = { writeBundledNotices };
