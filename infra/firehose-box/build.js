'use strict'

/**
 * build.js — esbuild bundler for the firehose box server.
 *
 * Bundles infra/firehose-box/server.js (which imports firehose-core.ts via
 * require('../lib/lambdas/pds/firehose-core')) into a single self-contained
 * CJS file at infra/firehose-box/dist/server.bundle.cjs.
 *
 * Approach:
 *   - esbuild follows the require('../lib/lambdas/pds/firehose-core') call
 *     and bundles the .ts file natively (esbuild supports TS by default).
 *   - @aws-sdk/* is kept EXTERNAL so the box can install only those via
 *     npm ci --omit=dev from its own package.json.
 *   - ws, @atproto/*, @ipld/*, mnemonist, etc. are bundled in.
 *   - The output is CJS (--format=cjs) so it runs with plain `node`.
 *
 * Usage:
 *   node build.js              (run directly)
 *   npm run build              (via package.json scripts.build)
 *
 * Output: dist/server.bundle.cjs
 */

// Use the esbuild installed in infra/node_modules (no new deps added to infra)
const { build } = require('../node_modules/esbuild')
const path = require('path')
const boxDir = __dirname
const bundledFile = path.join(boxDir, 'dist/server.bundle.cjs')

function buildFirehose(outfile = bundledFile) {
  return build({
    absWorkingDir: boxDir,
    entryPoints: ['server.js'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    external: ['@aws-sdk/*'],
    metafile: true,
  })
}

if (require.main === module) {
  buildFirehose().catch(error => {
    console.error('Firehose build failed:', error)
    process.exitCode = 1
  })
}

module.exports = { buildFirehose }
