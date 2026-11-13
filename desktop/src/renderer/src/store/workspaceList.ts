import type { SessionDto, WorkspaceDto } from '../../../shared/contract';

/**
 * List surgery for the workspace page, kept pure: the store patches are the
 * part most likely to silently reorder the rail's dropdown, so they are tested
 * without a daemon.
 */

/** Insert or replace by id, keeping position (a rename must not jump the list). */
export function replaceWorkspace(list: WorkspaceDto[], workspace: WorkspaceDto): WorkspaceDto[] {
  const index = list.findIndex((item) => item.id === workspace.id);
  if (index < 0) return [...list, workspace];
  const next = [...list];
  next[index] = workspace;
  return next;
}

export function removeWorkspace(list: WorkspaceDto[], id: string): WorkspaceDto[] {
  return list.filter((item) => item.id !== id);
}

export function setWorkspaceDirs(list: WorkspaceDto[], id: string, dirs: string[]): WorkspaceDto[] {
  return list.map((item) => (item.id === id ? { ...item, dirs } : item));
}

/** What the shell falls back to when the chosen workspace is gone. */
export function fallbackWorkspaceId(list: WorkspaceDto[]): string | null {
  return (list.find((item) => item.isDefault) ?? list[0])?.id ?? null;
}

/** Workspaces the management page edits: dev only. Life is reset-only. */
export function manageableWorkspaces(list: WorkspaceDto[]): WorkspaceDto[] {
  return list.filter((workspace) => workspace.family !== 'life');
}

/** User-facing workspace name. */
export function workspaceLabel(workspace: WorkspaceDto | null | undefined): string | null {
  if (!workspace) return null;
  if (workspace.family === 'life') return workspace.name || '个人空间';
  return workspace.name || workspace.path;
}

/**
 * First workspace to show when this device has no live choice: the one it used
 * last, then the daemon default, then the first. `remembered` is validated
 * against the list so a workspace deleted elsewhere is not requested.
 */
export function initialWorkspaceId(list: WorkspaceDto[], remembered: string | null): string | null {
  if (remembered && list.some((workspace) => workspace.id === remembered)) return remembered;
  return fallbackWorkspaceId(list);
}

/** Primary dir first, then the extra dirs. `workspace_dirs` never repeats the primary. */
export function workspaceDirectories(workspace: WorkspaceDto): string[] {
  return [workspace.path, ...workspace.dirs.filter((dir) => dir !== workspace.path)];
}

/** Drop trailing separators and use `/` so both platforms compare alike. */
function normalizeDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  // A bare root keeps its separator: `/` would otherwise trim to ''.
  return (trimmed || path).replace(/\\/g, '/');
}

/**
 * A session belongs to a directory when its cwd is that directory or below it.
 * A sibling with the same prefix (`/repo2` vs `/repo`) must not match, so the
 * separator is part of the test — the daemon canonicalises paths, but the rail
 * also sees cwds written by older clients.
 */
export function sessionMatchesDir(cwd: string, dir: string): boolean {
  const target = normalizeDir(dir);
  if (!target) return false;
  const current = normalizeDir(cwd);
  if (current === target) return true;
  // A filesystem root already ends in a separator; appending another (`//`)
  // would make every child miss.
  return current.startsWith(target === '/' ? '/' : `${target}/`);
}

export interface DirectoryStats {
  count: number;
  lastUsedAt: number;
}

export function directoryStats(sessions: SessionDto[], dir: string): DirectoryStats {
  let count = 0;
  let lastUsedAt = 0;
  for (const session of sessions) {
    if (!sessionMatchesDir(session.cwd, dir)) continue;
    count++;
    lastUsedAt = Math.max(lastUsedAt, session.lastActiveAt);
  }
  return { count, lastUsedAt };
}

/** Last path segment, for the compact "目录名" label in session rows. */
export function directoryName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function recentSessions(sessions: SessionDto[], limit = 6): SessionDto[] {
  return [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, limit);
}
