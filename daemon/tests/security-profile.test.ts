import { describe, expect, it } from 'vitest';

import {
  isBypassAllowed,
  resolveEffectivePermissionMode,
  resolveEffectiveStoredPermissionMode,
  type SecurityProfileConfig,
} from '../src/permissions/security-profile';

const local: SecurityProfileConfig = {
  securityProfile: 'local',
  allowLocalBypass: true,
  allowServerBypass: false,
};

const serverStrict: SecurityProfileConfig = {
  securityProfile: 'server-strict',
  allowLocalBypass: true,
  allowServerBypass: false,
};

describe('security profile permission gate', () => {
  it('downgrades bypass to acceptEdits when bypass is not allowed', () => {
    expect(resolveEffectivePermissionMode('bypass', serverStrict)).toBe('acceptEdits');
    expect(
      resolveEffectivePermissionMode('bypass', { ...serverStrict, allowServerBypass: true }),
    ).toBe('bypass');
    expect(resolveEffectivePermissionMode('bypass', local)).toBe('bypass');
  });

  it('leaves ask and acceptEdits unchanged', () => {
    for (const mode of ['ask', 'acceptEdits'] as const) {
      expect(resolveEffectivePermissionMode(mode, serverStrict)).toBe(mode);
      expect(resolveEffectivePermissionMode(mode, local)).toBe(mode);
    }
  });

  it('treats a missing config as the local default and preserves unknown stored modes', () => {
    expect(isBypassAllowed(undefined)).toBe(true);
    expect(resolveEffectiveStoredPermissionMode('bypass', undefined)).toBe('bypass');
    expect(resolveEffectiveStoredPermissionMode('legacy-mode', serverStrict)).toBe('legacy-mode');
  });

  it('uses only the switch for the active profile', () => {
    expect(isBypassAllowed({ ...serverStrict, allowLocalBypass: false })).toBe(false);
    expect(
      isBypassAllowed({ ...serverStrict, allowServerBypass: true, allowLocalBypass: false }),
    ).toBe(true);
    expect(
      isBypassAllowed({ ...local, allowLocalBypass: false, allowServerBypass: true }),
    ).toBe(false);
  });
});
