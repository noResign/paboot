import { describe, expect, it } from 'vitest';
import { listWindowsDrives } from '../src/platform/paths';

describe('listWindowsDrives', () => {
  it('returns nothing off Windows', () => {
    expect(listWindowsDrives({ platform: 'linux', exists: () => true })).toEqual([]);
  });

  it('lists only drive roots that exist, in A–Z order', () => {
    expect(
      listWindowsDrives({
        platform: 'win32',
        exists: (candidate) => candidate === 'C:\\' || candidate === 'F:\\',
      }),
    ).toEqual(['C:\\', 'F:\\']);
  });

  it('skips a drive whose probe throws instead of failing the whole listing', () => {
    expect(
      listWindowsDrives({
        platform: 'win32',
        exists: (candidate) => {
          if (candidate === 'D:\\') throw new Error('device not ready');
          return candidate === 'C:\\';
        },
      }),
    ).toEqual(['C:\\']);
  });
});
