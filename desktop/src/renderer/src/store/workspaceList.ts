import type { WorkspaceDto } from '../../../shared/contract';

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

/** Workspaces the user manages/sees; the built-in fallback is never rendered. */
export function visibleWorkspaces(list: WorkspaceDto[]): WorkspaceDto[] {
  return list.filter((workspace) => !workspace.isBuiltin);
}

/** User-facing name. The built-in fallback has no path the user should read. */
export function workspaceLabel(workspace: WorkspaceDto | null | undefined): string | null {
  if (!workspace) return null;
  return workspace.isBuiltin ? '内置工作区' : workspace.name || workspace.path;
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
