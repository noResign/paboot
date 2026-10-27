import { describe, expect, it } from 'vitest';
import {
  fallbackWorkspaceId,
  initialWorkspaceId,
  removeWorkspace,
  replaceWorkspace,
  setWorkspaceDirs,
  visibleWorkspaces,
  workspaceLabel,
} from './workspaceList';
import type { WorkspaceDto } from '../../../shared/contract';

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
