#!/usr/bin/env node
/**
 * Bundle the daemon we ship inside the desktop app.
 *
 * `daemon/dist` is plain `tsc` output, so its bare imports resolve by walking up
 * the tree: in the repo that finds `daemon/node_modules` (which is why `pnpm dev`
 * never noticed), and inside the app there is nothing to walk up to — the
 * packaged daemon died with `Cannot find package 'express'`.
 *
 * Bundling inlines the daemon's runtime dependencies (today: express and its
 * pure-JS tree) so the copy we ship has no bare imports at all, and the app keeps
 * needing no `node_modules`.
 *
 * **Three entries, not one**: `permission-hook.js` and
 * `mcp/servers/paboot_tasks/server.js` are spawned *by path* by the running
 * daemon (`ctx.hookPath` / `ctx.mcpServerPath`), so they have to exist as their
 * own files in the bundle. A missing `mcp/servers/paboot_tasks/server.js` makes
 * every run that mounts `paboot_tasks` fail at startup.
 *
 * The output **mirrors the daemon package layout** — `package.json` at the root,
 * `dist/` under it, the MCP entry under `dist/mcp/servers/paboot_tasks/` —
 * because three things are resolved relative to the entry at runtime and all
 * assume it: `ctx.hookPath` (`./permission-hook.js`),
 * `ctx.mcpServerPath` (`mcp/servers/paboot_tasks/server.js`), and the version
 * (`require('../package.json')` in `src/version.ts`). The package.json is the
 * daemon's own, copied verbatim: it carries the version *and* the
 * `"type": "module"` that makes these files load as ESM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const from = path.join(repo, 'daemon', 'dist');
const outRoot = path.join(repo, 'desktop', 'build', 'daemon');
const outDir = path.join(outRoot, 'dist');

const entries = ['index.js', 'permission-hook.js', 'mcp/servers/paboot_tasks/server.js'];
for (const entry of entries) {
  if (!fs.existsSync(path.join(from, entry))) {
    console.error(`缺少 ${path.join(from, entry)}——先编译 daemon（pnpm build 的 prebuild 会做）`);
    process.exit(1);
  }
}

// Start clean: a stale file here would be packaged as if it were current.
fs.rmSync(outRoot, { recursive: true, force: true });

await build({
  entryPoints: entries.map((entry) => path.join(from, entry)),
  outdir: outDir,
  // Preserve `mcp/servers/paboot_tasks/` under dist/.
  outbase: from,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Electron 44 ships Node 24 (`node:sqlite` is what the daemon stores with).
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    // ESM output has no `require`, but some of express's CJS tree calls it
    // *dynamically* (`depd` does `require('path')`), which esbuild cannot turn
    // into an import — it emits a helper that throws unless a `require` exists in
    // scope. This is esbuild's documented shim for exactly that.
    js: "import { createRequire as __bundleCreateRequire } from 'node:module';\nconst require = __bundleCreateRequire(import.meta.url);",
  },
});

fs.copyFileSync(path.join(repo, 'daemon', 'package.json'), path.join(outRoot, 'package.json'));

const sizes = entries
  .map((entry) => ({ entry, file: path.join(outDir, entry) }))
  .filter(({ file }) => fs.existsSync(file))
  .map(({ entry, file }) => `${entry} ${(fs.statSync(file).size / 1024).toFixed(0)}K`)
  .join(', ');
console.log(`==> daemon bundled → build/daemon/dist (${sizes}) + package.json`);
