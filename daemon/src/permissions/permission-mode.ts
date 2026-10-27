import type { Config } from '../app/config.js';
import type { Db } from '../db/db.js';

export const PRODUCT_PERMISSION_MODES = ['ask', 'acceptEdits', 'bypass'] as const;
export type ProductPermissionMode = (typeof PRODUCT_PERMISSION_MODES)[number];

export const SETTING_DEFAULT_PERMISSION_MODE = 'default_permission_mode';

export function isProductPermissionMode(value: unknown): value is ProductPermissionMode {
  return typeof value === 'string' && (PRODUCT_PERMISSION_MODES as readonly string[]).includes(value);
}

/** Map the legacy daemon env value to one of the three product modes. */
export function fromLegacyPermissionMode(mode: string): ProductPermissionMode {
  if (mode === 'bypassPermissions') return 'bypass';
  if (mode === 'acceptEdits') return 'acceptEdits';
  return 'ask';
}

/** Map the product mode to Claude Code's `--permission-mode` value. */
export function toClaudePermissionMode(mode: ProductPermissionMode): string {
  if (mode === 'bypass') return 'bypassPermissions';
  if (mode === 'acceptEdits') return 'acceptEdits';
  return 'default';
}

export function getDefaultPermissionMode(db: Db, config: Config): ProductPermissionMode {
  const saved = db.getSetting(SETTING_DEFAULT_PERMISSION_MODE);
  if (isProductPermissionMode(saved)) return saved;
  return fromLegacyPermissionMode(config.permissionMode);
}
