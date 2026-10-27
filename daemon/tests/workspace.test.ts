import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceCwd } from '../src/workspaces/workspace';

describe('resolveWorkspaceCwd', () => {
  const root = '/home/user/projects';

  it('allows the workspace root itself', () => {
    expect(resolveWorkspaceCwd(root, root)).toBe(root);
  });

  it('expands a leading ~ in the cwd before checking containment', () => {
    const home = os.homedir();
    expect(resolveWorkspaceCwd('~/projects/app', path.join(home, 'projects'))).toBe(
      path.join(home, 'projects', 'app'),
    );
  });

  it('allows descendants of the workspace root', () => {
    expect(resolveWorkspaceCwd('/home/user/projects/app', root)).toBe('/home/user/projects/app');
    expect(resolveWorkspaceCwd('/home/user/projects/a/b/c', root)).toBe('/home/user/projects/a/b/c');
  });

  it('rejects escaping above the root via ..', () => {
    expect(resolveWorkspaceCwd('/home/user/projects/../../etc', root)).toBeNull();
  });

  it('rejects a sibling directory', () => {
    expect(resolveWorkspaceCwd('/home/user/other', root)).toBeNull();
  });

  it('rejects a prefix-matched sibling (projects-other vs projects)', () => {
    expect(resolveWorkspaceCwd('/home/user/projects-other', root)).toBeNull();
  });

  it('rejects the filesystem root', () => {
    expect(resolveWorkspaceCwd('/', root)).toBeNull();
  });
});
