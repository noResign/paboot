import { describe, expect, it } from 'vitest';
import {
  directoryName,
  directoryStats,
  fallbackWorkspaceId,
  initialWorkspaceId,
  recentSessions,
  removeWorkspace,
  replaceWorkspace,
  sessionMatchesDir,
  setWorkspaceDirs,
  visibleWorkspaces,
  workspaceDirectories,
  workspaceLabel,
} from './workspaceList';
import type { SessionDto, WorkspaceDto } from '../../../shared/contract';

function ws(id: string, overrides: Partial<WorkspaceDto> = {}): WorkspaceDto {
  return {
    id,
    name: id,
    path: `/home/${id}`,
    dirs: [],
    shortcutDirs: [],
    isDefault: false,
    isBuiltin: false,
    enabled: true,
    sessionCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
}

describe('replaceWorkspace', () => {
  it('appends a workspace that is not in the list yet', () => {
    expect(replaceWorkspace([ws('a')], ws('b')).map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('replaces in place, so a rename does not jump the rail dropdown', () => {
    const list = [ws('a'), ws('b'), ws('c')];
    const renamed = replaceWorkspace(list, ws('b', { name: 'B!' }));
    expect(renamed.map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(renamed[1]?.name).toBe('B!');
  });
});

describe('removeWorkspace', () => {
  it('drops by id and leaves the rest alone', () => {
    expect(removeWorkspace([ws('a'), ws('b')], 'a').map((w) => w.id)).toEqual(['b']);
  });
});

describe('setWorkspaceDirs', () => {
  it('replaces only the targeted workspace dirs', () => {
    const list = [ws('a', { dirs: ['/x'] }), ws('b', { dirs: ['/y'] })];
    const next = setWorkspaceDirs(list, 'a', ['/x', '/z']);
    expect(next[0]?.dirs).toEqual(['/x', '/z']);
    expect(next[1]?.dirs).toEqual(['/y']);
  });
});

describe('fallbackWorkspaceId', () => {
  it('prefers the default, else the first, else null', () => {
    expect(fallbackWorkspaceId([ws('a'), ws('b', { isDefault: true })])).toBe('b');
    expect(fallbackWorkspaceId([ws('a'), ws('b')])).toBe('a');
    expect(fallbackWorkspaceId([])).toBeNull();
  });
});

describe('initialWorkspaceId', () => {
  it('opens the workspace this device used last when it still exists', () => {
    const list = [ws('a'), ws('b', { isDefault: true })];
    expect(initialWorkspaceId(list, 'a')).toBe('a');
  });

  it('falls back when the remembered workspace is gone', () => {
    const list = [ws('a'), ws('b', { isDefault: true })];
    expect(initialWorkspaceId(list, 'deleted')).toBe('b');
    expect(initialWorkspaceId(list, null)).toBe('b');
  });

  it('returns null for an empty list', () => {
    expect(initialWorkspaceId([], 'a')).toBeNull();
  });

  it('can pick the built-in fallback internally', () => {
    const list = [ws('builtin', { isBuiltin: true, isDefault: true })];
    expect(initialWorkspaceId(list, null)).toBe('builtin');
  });
});

describe('visibleWorkspaces', () => {
  it('never renders the built-in fallback', () => {
    const list = [ws('builtin', { isBuiltin: true }), ws('real')];
    expect(visibleWorkspaces(list).map((w) => w.id)).toEqual(['real']);
  });
});

describe('workspaceLabel', () => {
  it('hides the built-in fallback path behind a generic label', () => {
    expect(workspaceLabel(ws('builtin', { isBuiltin: true }))).toBe('内置工作区');
    expect(workspaceLabel(ws('real', { name: '项目' }))).toBe('项目');
    expect(workspaceLabel(ws('real', { name: '' }))).toBe('/home/real');
    expect(workspaceLabel(null)).toBeNull();
  });
});

describe('workspaceDirectories', () => {
  it('puts the primary dir first and never repeats it', () => {
    expect(workspaceDirectories(ws('a', { path: '/repo', dirs: ['/extra', '/repo', '/tools'] }))).toEqual([
      '/repo',
      '/extra',
      '/tools',
    ]);
  });
});

describe('sessionMatchesDir', () => {
  it('matches the directory itself and anything below it', () => {
    expect(sessionMatchesDir('/repo', '/repo')).toBe(true);
    expect(sessionMatchesDir('/repo/src/app', '/repo')).toBe(true);
  });

  it('does not match a sibling sharing the prefix', () => {
    expect(sessionMatchesDir('/repo2', '/repo')).toBe(false);
    expect(sessionMatchesDir('/repo-work/src', '/repo')).toBe(false);
  });

  it('ignores trailing separators and handles both separators', () => {
    expect(sessionMatchesDir('/repo/', '/repo/')).toBe(true);
    expect(sessionMatchesDir('C:\\repo\\src', 'C:\\repo')).toBe(true);
    expect(sessionMatchesDir('C:\\repo2', 'C:\\repo')).toBe(false);
  });

  it('still matches children of a filesystem root', () => {
    expect(sessionMatchesDir('/home/me', '/')).toBe(true);
    expect(sessionMatchesDir('/', '/')).toBe(true);
    expect(sessionMatchesDir('C:\\work\\repo', 'C:\\')).toBe(true);
  });

  it('treats mixed separators as the same path', () => {
    expect(sessionMatchesDir('/repo\\src', '/repo')).toBe(true);
    expect(sessionMatchesDir('C:/repo', 'C:\\repo')).toBe(true);
  });

  it('matches nothing against an empty dir', () => {
    expect(sessionMatchesDir('/repo', '')).toBe(false);
  });
});

describe('directoryStats', () => {
  it('counts matching sessions and keeps the latest activity', () => {
    const sessions = [session('a', '/repo', 10), session('b', '/repo/src', 30), session('c', '/other', 99)];
    expect(directoryStats(sessions, '/repo')).toEqual({ count: 2, lastUsedAt: 30 });
  });

  it('returns zeroes for a directory without sessions', () => {
    expect(directoryStats([session('a', '/repo', 10)], '/empty')).toEqual({ count: 0, lastUsedAt: 0 });
  });
});

describe('directoryName', () => {
  it('uses the last path segment on both separators', () => {
    expect(directoryName('/home/me/project')).toBe('project');
    expect(directoryName('C:\\work\\project\\')).toBe('project');
  });
});

describe('recentSessions', () => {
  it('orders by last activity and respects the limit', () => {
    const sessions = [session('a', '/repo', 10), session('b', '/repo', 30), session('c', '/repo', 20)];
    expect(recentSessions(sessions, 2).map((item) => item.id)).toEqual(['b', 'c']);
    expect(sessions.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

function session(id: string, cwd: string, lastActiveAt: number): SessionDto {
  return {
    id,
    runtime: 'claude',
    workspaceId: 'ws',
    permissionMode: 'ask',
    model: null,
    modelParameters: null,
    cwd,
    title: id,
    createdAt: 0,
    lastActiveAt,
    running: false,
    runningRunId: null,
  };
}
