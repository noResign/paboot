import type { MemorySettingsRow, WorkspaceRow } from '../db/db.js';
import { effectiveMemorySettings, type MemoryProfileMode } from './settings.js';
import type { MemoryClaim, MemoryScope } from './types.js';

export interface ReadScope {
  scope: MemoryScope;
  /**
   * Whether `private` claims from this scope are readable. Cross-workspace
   * reads are normal-only (D8 / D27); `secret` is never readable anywhere.
   */
  includePrivate: boolean;
}

export interface MemoryReadPolicy {
  scopes: ReadScope[];
  profileMode: MemoryProfileMode;
  /** Life may read `user`; dev never does. */
  includesUser: boolean;
}

export interface ReadPolicyInput {
  workspace: WorkspaceRow;
  workspaces: readonly WorkspaceRow[];
  getSettings(workspaceId: string): MemorySettingsRow | undefined;
}

/**
 * D7 / D27 read composition:
 *   dev  → only its own workspace;
 *   life → `user` + life workspace + every `life_readable=1` dev workspace.
 * A disabled workspace contributes nothing. Cross-workspace dev claims are
 * normal-only; private never crosses and secret never leaves the store.
 */
export function resolveReadPolicy(input: ReadPolicyInput): MemoryReadPolicy {
  const { workspace } = input;
  const own = effectiveMemorySettings(workspace, input.getSettings(workspace.id));
  if (!own.enabled) return { scopes: [], profileMode: 'off', includesUser: false };

  if (workspace.family === 'dev') {
    return {
      scopes: [{ scope: `workspace:${workspace.id}`, includePrivate: true }],
      profileMode: 'off',
      includesUser: false,
    };
  }

  const profileMode = own.profileMode ?? 'portable';
  const scopes: ReadScope[] = [];
  if (profileMode !== 'off') {
    scopes.push({ scope: 'user', includePrivate: profileMode === 'full' });
  }
  scopes.push({ scope: `workspace:${workspace.id}`, includePrivate: true });
  for (const candidate of input.workspaces) {
    if (candidate.id === workspace.id || candidate.family !== 'dev') continue;
    if (candidate.life_readable !== 1 || candidate.enabled !== 1) continue;
    const settings = effectiveMemorySettings(candidate, input.getSettings(candidate.id));
    if (!settings.enabled) continue;
    scopes.push({ scope: `workspace:${candidate.id}`, includePrivate: false });
  }
  return { scopes, profileMode, includesUser: profileMode !== 'off' };
}

/** Explicit `scope=user` reads (operator / CLI); life routing still owns writes. */
export function userReadPolicy(): MemoryReadPolicy {
  return {
    scopes: [{ scope: 'user', includePrivate: true }],
    profileMode: 'full',
    includesUser: true,
  };
}

export function scopeAllowsSensitivity(
  policy: MemoryReadPolicy,
  scope: MemoryScope,
  sensitivity: 'normal' | 'private' | 'secret',
): boolean {
  if (sensitivity === 'secret') return false;
  const readScope = policy.scopes.find((item) => item.scope === scope);
  if (!readScope) return false;
  return readScope.includePrivate || sensitivity === 'normal';
}

export function claimAllowed(claim: MemoryClaim, policy: MemoryReadPolicy): boolean {
  if (!scopeAllowsSensitivity(policy, claim.scope, claim.sensitivity)) return false;
  if (claim.scope === 'user') {
    if (policy.profileMode === 'off') return false;
    if (policy.profileMode === 'portable') return claim.shareClass === 'portable';
  }
  return true;
}
