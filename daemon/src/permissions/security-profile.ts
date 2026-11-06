import type { ProductPermissionMode } from './permission-mode.js';
import { isProductPermissionMode } from './permission-mode.js';

/**
 * The two explicit bypass switches, kept per profile. This is the only config
 * shape the permission gate needs; no separate "resolved policy" type.
 */
export interface SecurityProfileConfig {
  securityProfile: 'local' | 'server-strict';
  allowLocalBypass: boolean;
  allowServerBypass: boolean;
}

/**
 * Partial test contexts (and older call sites) may omit `builtinConfig`; the
 * product default is the local profile, which allows bypass.
 */
export const DEFAULT_SECURITY_PROFILE: SecurityProfileConfig = {
  securityProfile: 'local',
  allowLocalBypass: true,
  allowServerBypass: false,
};

/** Only the flag for the active profile applies. */
export function allowBypassFor(config: SecurityProfileConfig): boolean {
  return config.securityProfile === 'local'
    ? config.allowLocalBypass
    : config.allowServerBypass;
}

export function isBypassAllowed(config: SecurityProfileConfig | undefined | null): boolean {
  return allowBypassFor(config ?? DEFAULT_SECURITY_PROFILE);
}

/**
 * One gate for every runtime and every API that can hand out `bypass`.
 *
 * `server-strict` defaults to disallowing bypass, but `allowServerBypass: true`
 * is an explicit admin override (some servers really do want full access).
 * Without the override, bypass is downgraded to `acceptEdits` so workspace
 * edits keep working while commands/MCP still require approval.
 */
export function resolveEffectivePermissionMode(
  requested: ProductPermissionMode,
  config?: SecurityProfileConfig | null,
): ProductPermissionMode {
  if (requested === 'bypass' && !isBypassAllowed(config)) return 'acceptEdits';
  return requested;
}

/** Same gate for a raw stored mode that may be legacy/invalid. */
export function resolveEffectiveStoredPermissionMode(
  mode: string,
  config?: SecurityProfileConfig | null,
): string {
  return isProductPermissionMode(mode)
    ? resolveEffectivePermissionMode(mode, config)
    : mode;
}
