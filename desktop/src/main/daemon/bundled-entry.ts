import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the daemon we ship lives.
 *
 * The daemon ships inside the app so「启动一个本机 daemon」works on a fresh
 * install, with nothing for the user to install first. (Bundling it also keeps
 * the two in step, but that is a convenience, not the reason.)
 *
 * Two layouts, because dev and a packaged app differ:
 * - packaged: `extraResources` copies the **bundled** daemon
 *   (`desktop/build/daemon`, produced by `scripts/bundle-daemon.mjs`) to
 *   `<resources>/daemon/`, so the entry is `<resources>/daemon/dist/index.js`;
 * - dev: the sibling checkout, `../daemon/dist/index.js` (the desktop package is
 *   `paboot-desktop`, so the daemon is one directory over) — raw tsc output, whose
 *   bare imports resolve against `daemon/node_modules`.
 *
 * The packaged layout mirrors the daemon package (`package.json` + `dist/`)
 * because the daemon resolves two things relative to its entry at runtime: the
 * permission hook beside it, and its version from `../package.json`.
 *
 * Returns null when there is nothing there — the honest answer, and the one the
 * UI needs in order to say「没有可启动的 daemon」instead of failing at spawn.
 */
export function resolveBundledEntry(input: {
  isPackaged: boolean;
  /** `app.getAppPath()` — the app's own directory. */
  appPath: string;
  /** `process.resourcesPath` — where `extraResources` land. */
  resourcesPath: string;
  exists?: (candidate: string) => boolean;
}): string | null {
  const exists = input.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const candidate = input.isPackaged
    ? path.join(input.resourcesPath, 'daemon', 'dist', 'index.js')
    : path.join(input.appPath, '..', 'daemon', 'dist', 'index.js');
  const resolved = path.resolve(candidate);
  return exists(resolved) ? resolved : null;
}
