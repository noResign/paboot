import fs from 'node:fs';
import path from 'node:path';
import type { Db, WorkspaceRow } from '../db/db.js';
import { expandHome } from '../platform/paths.js';
import { resolveWorkspaceCwd } from './workspace.js';

export class WorkspaceValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Canonical absolute path for an existing directory. */
export function canonicalizeExistingDirectory(raw: string): string {
  const abs = path.resolve(expandHome(raw));
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new WorkspaceValidationError(`directory not found: ${raw}`, 'directory_not_found');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new WorkspaceValidationError(`directory not accessible: ${raw}`, 'directory_not_accessible');
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceValidationError(`not a directory: ${raw}`, 'not_a_directory');
  }
  return real;
}

export function workspaceContains(workspacePath: string, candidate: string): boolean {
  return resolveWorkspaceCwd(candidate, workspacePath) !== null;
}

/** Every root a session in this workspace may touch: primary first, then extra dirs. */
export function workspaceRoots(db: Db, workspace: WorkspaceRow): string[] {
  return [workspace.path, ...db.listWorkspaceDirs(workspace.id)];
}

/** True when `candidate` is inside any of the workspace's roots. */
export function workspaceContainsAny(roots: string[], candidate: string): boolean {
  return roots.some((root) => workspaceContains(root, candidate));
}

/**
 * realpath + drop entries that vanished or stopped being directories, so a
 * deleted extra dir degrades to "the agent simply can't see it" instead of
 * failing the spawn. Used when building `--add-dir`; never written back to the
 * stored config, so a temporarily-unmounted dir isn't silently forgotten.
 */
export function existingDirs(paths: string[]): string[] {
  const alive: string[] = [];
  for (const p of paths) {
    try {
      const real = fs.realpathSync(p);
      if (fs.statSync(real).isDirectory()) alive.push(real);
    } catch {
      // gone between approval and spawn
    }
  }
  return alive;
}

export function resolveWorkspaceForRequest(db: Db, workspaceId?: string): WorkspaceRow | null {
  if (workspaceId) {
    const ws = db.getWorkspace(workspaceId);
    return ws && ws.enabled === 1 ? ws : null;
  }
  return db.getDefaultWorkspace() ?? db.listWorkspaces().find((w) => w.enabled === 1) ?? null;
}
