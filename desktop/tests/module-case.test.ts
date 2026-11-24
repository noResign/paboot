import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * No two modules in one directory may differ only by case.
 *
 * On a case-insensitive filesystem (macOS default, Windows) an extensionless
 * import resolves through the extension list, and `.ts` is tried before `.tsx`.
 * So `./TodoPanel` from a component next to both `TodoPanel.tsx` and
 * `todoPanel.ts` picks the lowercase helper — a module that exports no
 * component — and the renderer imports nothing and paints a blank window.
 *
 * Linux (the only CI target) cannot reproduce it, so this scan is the guard.
 */

const SRC = resolve(import.meta.dirname, '../src');
const SKIP = new Set(['node_modules', 'out', 'build', 'release', 'dist']);

function walk(dir: string, found: Map<string, string[]> = new Map()): Map<string, string[]> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(join(dir, entry.name), found);
      continue;
    }
    // Stem only: `foo.ts` and `Foo.tsx` are the pair that breaks resolution.
    const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase();
    const key = join(dir, stem);
    found.set(key, [...(found.get(key) ?? []), entry.name]);
  }
  return found;
}

describe('module case', () => {
  it('has no directory-local pair of modules whose names differ only by case', () => {
    const collisions = [...walk(SRC)]
      .filter(([, names]) => names.length > 1)
      .map(([dir, names]) => `${relative(SRC, dir)} → ${names.sort().join(', ')}`);
    expect(collisions).toEqual([]);
  });
});
