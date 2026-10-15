import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

/**
 * The regression this guards: `--workspace ~/x` reached the daemon as a raw
 * argv string (no shell), and `path.resolve` turned `~` into a relative segment
 * under the daemon's cwd — silently creating `<cwd>/~/x` instead of the home
 * directory the user meant.
 */
describe('loadConfig workspace', () => {
  const originalHome = process.env.HOME;
  let home: string | null = null;

  afterEach(() => {
    process.env.HOME = originalHome;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('expands a leading ~ to the home dir rather than the daemon cwd', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-home-'));
    process.env.HOME = home;

    const config = loadConfig({}, { workspace: '~/proj', dataDir: path.join(home, 'data'), port: 4780 });

    expect(config.workspace).toBe(path.join(home, 'proj'));
    expect(config.workspace).not.toContain('~');
    expect(config.workspaceSource).toBe('flag');
    expect(fs.statSync(config.workspace).isDirectory()).toBe(true);
  });

  it('expands ~ in the data dir too', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-home-'));
    process.env.HOME = home;

    const config = loadConfig({}, { workspace: path.join(home, 'proj'), dataDir: '~/state', port: 4780 });

    expect(config.dataDir).toBe(path.join(home, 'state'));
  });
});
