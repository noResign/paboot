import { describe, expect, it } from 'vitest';

import {
  clampPermissionMode,
  permissionModeLabel,
  permissionModeOptions,
} from '../src/shared/runtime-identity';

describe('permission mode options', () => {
  it('offers bypass only when the daemon allows it', () => {
    expect(permissionModeOptions('builtin').map((option) => option.mode)).toEqual([
      'ask',
      'acceptEdits',
      'bypass',
    ]);
    expect(permissionModeOptions('builtin', true).map((option) => option.mode)).toEqual([
      'ask',
      'acceptEdits',
      'bypass',
    ]);
    expect(permissionModeOptions('builtin', false).map((option) => option.mode)).toEqual([
      'ask',
      'acceptEdits',
    ]);
  });

  it('clamps a legacy bypass selection to acceptEdits', () => {
    expect(clampPermissionMode('bypass', false)).toBe('acceptEdits');
    expect(clampPermissionMode('bypass', true)).toBe('bypass');
    expect(clampPermissionMode('ask', false)).toBe('ask');
  });

  it('labels unknown wire values without throwing', () => {
    expect(permissionModeLabel('bypass')).toBe('全部通过');
    expect(permissionModeLabel('legacy-mode')).toBe('legacy-mode');
  });
});
