import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The live debug capture is optional tooling. Keep it contained: only a small,
 * explicit set of production files may import `src/debug/`, and every
 * integration point carries the `[debug]` marker so it is greppable.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../src');
const debugDir = path.join(srcDir, 'debug');

/** Files allowed to talk to the debug domain from outside it. */
const ALLOWED_IMPORTERS = new Set(['index.ts', 'app/context.ts', 'routes/debug.ts']);

/** Production seams that must stay marked for discoverability. */
const MARKED_TOUCHPOINTS = [
  'app/config.ts',
  'app/context.ts',
  'app/server.ts',
  'index.ts',
  'runs/run-service.ts',
  'runs/memory-context.ts',
  'runs/memory-recall.ts',
  'runtimes/builtin/driver.ts',
  'runtimes/builtin/kernel/agent.ts',
  'memory/extract.ts',
  'memory/worker.ts',
  'platform/debug-flag.ts',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function relative(file: string): string {
  return path.relative(srcDir, file).split(path.sep).join('/');
}

function debugImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const pattern of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const resolved = path.resolve(
        path.dirname(file),
        specifier.replace(/\.js$/, ''),
      );
      if (resolved === debugDir || resolved.startsWith(debugDir + path.sep)) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

describe('debug containment', () => {
  it('is imported only by the allow-listed integration files', () => {
    const violations: string[] = [];
    for (const file of walk(srcDir)) {
      if (file.startsWith(debugDir + path.sep)) continue;
      const imports = debugImports(file);
      if (imports.length === 0) continue;
      if (!ALLOWED_IMPORTERS.has(relative(file))) {
        violations.push(`${relative(file)} imports ${imports.join(', ')}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the [debug] marker on every production seam', () => {
    const missing = MARKED_TOUCHPOINTS.filter(
      (file) => !fs.readFileSync(path.join(srcDir, file), 'utf8').includes('[debug]'),
    );
    expect(missing).toEqual([]);
  });
});
