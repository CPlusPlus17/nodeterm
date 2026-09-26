// Bundles host-fixture.ts for InteropHarness.kt through esbuild's JS API, so the harness only ever
// spawns `node` (audit A70).
//
// Usage (cwd = the repo root): node bundle-fixture.cjs <outfile> <electron stub, repo-relative>
//
// Why not the `esbuild` command: `node_modules/.bin/esbuild` is an npm shim, and on Windows the
// extensionless one is a sh script beside esbuild.cmd. CreateProcess (what Java's ProcessBuilder
// uses) runs neither, so bundling threw an IOException and every interop test errored on Windows
// instead of running. Why not `node node_modules/esbuild/bin/esbuild` either: esbuild's install
// script replaces that JS file with the native executable on Linux and macOS (skipped only under
// `--ignore-scripts` or yarn), and node cannot run a native executable. The JS API resolves the
// platform's esbuild binary itself on every OS.
//
// The options are the ones the harness used to pass on the command line, one for one: `electron`
// aliased to the stub (audit A60), `ws` external (it resolves from the repo's node_modules at run
// time), and the repo's two path aliases. Relative alias targets resolve against the cwd, as they did
// for the CLI.
'use strict'
const path = require('path')

const [outfile, electronStub] = process.argv.slice(2)
if (!outfile || !electronStub) {
  console.error('usage: node bundle-fixture.cjs <outfile> <electron stub, repo-relative>')
  process.exit(2)
}

const root = process.cwd()
// Resolved from the repo root, the tree whose node_modules the harness checked for esbuild.
const esbuild = require(require.resolve('esbuild', { paths: [root] }))

esbuild
  .build({
    absWorkingDir: root,
    entryPoints: ['android/protocol/src/test/interop/host-fixture.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.resolve(root, outfile),
    alias: {
      electron: './' + electronStub,
      '@shared': './src/shared',
      '@renderer': './src/renderer'
    },
    external: ['ws'],
    logLevel: 'warning'
  })
  .catch(() => {
    // esbuild has already printed the errors (logLevel 'warning' includes them) to stderr, which the
    // harness folds into its failure message.
    process.exitCode = 1
  })
