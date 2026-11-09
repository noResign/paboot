import type { MemorySettingsRow, WorkspaceRow } from '../db/db.js';

export type MemoryProfileMode = 'off' | 'portable' | 'full';

export interface EffectiveMemorySettings {
  enabled: boolean;
  injectionEnabled: boolean;
  providerOverride: string | null;
  /** Only meaningful for life; undefined for dev. */
  profileMode?: MemoryProfileMode;
  /** Only meaningful for dev; undefined for life. */
  lifeReadable?: boolean;
}

export function isMemoryProfileMode(value: unknown): value is MemoryProfileMode {
  return value === 'off' || value === 'portable' || value === 'full';
}

/**
 * Product defaults (D35): dev workspaces are opt-in, life is on, injection is
 * on, `profileMode=portable`, and `life_readable=0`. A missing settings row is
 * therefore not equivalent to "all zeros".
 */
export function effectiveMemorySettings(
  workspace: WorkspaceRow,
  row: MemorySettingsRow | undefined,
): EffectiveMemorySettings {
  const life = workspace.family === 'life';
  return {
    enabled: row ? row.enabled === 1 : life,
    injectionEnabled: row ? row.injection_enabled === 1 : true,
    providerOverride: row?.provider_override ?? null,
    ...(life
      ? { profileMode: (workspace.profile_mode as MemoryProfileMode) || 'portable' }
      : { lifeReadable: workspace.life_readable === 1 }),
  };
}

export function isMemoryEnabled(
  workspace: WorkspaceRow,
  row: MemorySettingsRow | undefined,
): boolean {
  return effectiveMemorySettings(workspace, row).enabled;
}

export function isMemoryInjectionEnabled(
  workspace: WorkspaceRow,
  row: MemorySettingsRow | undefined,
): boolean {
  const settings = effectiveMemorySettings(workspace, row);
  return settings.enabled && settings.injectionEnabled;
}
