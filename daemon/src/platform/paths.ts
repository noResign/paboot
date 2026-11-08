import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~` to the daemon user's home (`~` and `~/` / `~\` only;
 * `~user` is not supported).
 *
 * Clients hand paths over as raw argv or JSON — there is no shell in either
 * path — so `~/x` would otherwise be resolved by `path.resolve` as a relative
 * path, landing under the daemon's cwd (for the desktop that is its own app
 * directory). `~` means the home of the machine the daemon runs on, which is
 * the same shell semantics a user typing it locally would expect.
 */
export function expandHome(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export interface ListWindowsDrivesOptions {
  /** Injected for tests. */
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
}

/**
 * Drive roots on Windows (`C:\`, `D:\`, …), A:–Z:.
 *
 * The directory picker is rooted at the user's home (`C:\Users\…`), and
 * `path.dirname('C:\\') === 'C:\\'`, so there is nowhere above C: to navigate.
 * Listing the other roots is the only way a client can reach D:/F: at all.
 * Empty optical drives report `exists === false` and are skipped.
 *
 * Always empty off Windows — drives are a property of the daemon's host, not
 * the client's, so a remote Linux daemon must not advertise the client's.
 */
export function listWindowsDrives(options: ListWindowsDrivesOptions = {}): string[] {
  if ((options.platform ?? process.platform) !== 'win32') return [];
  const exists = options.exists ?? fs.existsSync;
  const drives: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (exists(root)) drives.push(root);
    } catch {
      // A drive that throws on probe is simply not browsable.
    }
  }
  return drives;
}
