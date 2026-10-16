import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBundledEntry } from './bundled-entry';

const base = { isPackaged: false, appPath: '/repo/paboot-desktop', resourcesPath: '/app/resources' };

describe('resolveBundledEntry', () => {
  it('looks in extraResources when packaged', () => {
    const entry = resolveBundledEntry({
      ...base,
      isPackaged: true,
      exists: (candidate) => {
        // The bundled daemon mirrors the daemon package layout (see
        // `scripts/bundle-daemon.mjs`): its own package.json sits one level up.
        expect(candidate).toBe(path.resolve('/app/resources/daemon/dist/index.js'));
        return true;
      },
    });
    expect(entry).toBe(path.resolve('/app/resources/daemon/dist/index.js'));
  });

  it('falls back to the sibling checkout in dev', () => {
    const entry = resolveBundledEntry({
      ...base,
      exists: (candidate) => {
        expect(candidate).toBe(path.resolve('/repo/daemon/dist/index.js'));
        return true;
      },
    });
    expect(entry).toBe(path.resolve('/repo/daemon/dist/index.js'));
  });

  it('returns null when nothing is there, rather than a path that would fail at spawn', () => {
    expect(resolveBundledEntry({ ...base, exists: () => false })).toBeNull();
  });
});
