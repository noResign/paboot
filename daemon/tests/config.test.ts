import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/app/config';

/**
 * Two regressions this guards:
 *
 * - `--workspace ~/x` reached the daemon as a raw argv string (there is no shell
 *   in that path), and `path.resolve` turned `~` into a relative segment under
 *   the daemon's cwd — silently creating `<cwd>/~/x` instead of the home
 *   directory the user meant.
 * - the data root is fixed at `~/.paboot`. It has to be, because `serverId` is
 *   minted once and persisted in the DB there: a movable root would move this
 *   daemon's identity with it.
 */
describe('loadConfig', () => {
  const originalHome = process.env.HOME;
  let home: string | null = null;

  afterEach(() => {
    process.env.HOME = originalHome;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = null;
  });

  /** Patch HOME (what `os.homedir()` reads on POSIX) to a throwaway dir. */
  function tempHome(): string {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-home-'));
    process.env.HOME = home;
    return home;
  }

  it('expands a leading ~ in the workspace to the home dir, not the daemon cwd', () => {
    const dir = tempHome();
    const config = loadConfig({}, { workspace: '~/proj', port: 4780 });

    expect(config.workspace).toBe(path.join(dir, 'proj'));
    expect(config.workspace).not.toContain('~');
    expect(config.workspaceSource).toBe('flag');
    expect(fs.statSync(config.workspace).isDirectory()).toBe(true);
  });

  it('fixes the data dir at ~/.paboot, and neither the env var nor an override reaches it', () => {
    const dir = tempHome();
    const config = loadConfig({}, { workspace: path.join(dir, 'proj'), port: 4780 });

    expect(config.dataDir).toBe(path.join(dir, '.paboot'));
    expect(fs.statSync(config.dataDir).isDirectory()).toBe(true);
    expect(loadConfig({ PABOOT_DATA_DIR: path.join(dir, 'elsewhere') }, { port: 4780 }).dataDir).toBe(
      path.join(dir, '.paboot'),
    );
  });
});
