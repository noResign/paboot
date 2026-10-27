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
