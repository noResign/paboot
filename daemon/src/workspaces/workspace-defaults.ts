import type { WorkspaceRow } from '../db/db.js';
import { isProductPermissionMode, type ProductPermissionMode } from '../permissions/permission-mode.js';

/**
 * New-session defaults live on the workspace and are inherited by every new
 * session that does not carry an explicit choice. Existing sessions keep their
 * own runtime / permission mode forever.
 */
export function resolveNewSessionRuntime(
  workspace: WorkspaceRow,
  requested: string | undefined,
  fallback = 'claude',
): string {
  return requested ?? workspace.default_runtime ?? fallback;
}

export function resolveNewSessionPermissionMode(
  workspace: WorkspaceRow,
  requested: ProductPermissionMode | undefined,
  globalDefault: ProductPermissionMode,
): ProductPermissionMode {
  if (requested) return requested;
  return isProductPermissionMode(workspace.default_permission_mode)
    ? workspace.default_permission_mode
    : globalDefault;
}
