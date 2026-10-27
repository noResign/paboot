import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guard the folder boundaries described in daemon/docs/daemon.md.
 *
 * The daemon is small enough that a bad import is easy to miss in review, and
 * once a lower layer imports `app/` (or a domain reaches into `routes/`) the
 * layering is gone. These tests fail fast on that drift.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../src');

type Bucket = 'root' | 'app' | 'http' | 'platform' | 'db' | 'routes' | 'runtimes' | 'types' | 'domain';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function bucketOf(file: string): Bucket {
  const rel = path.relative(srcDir, file).split(path.sep);
  if (rel.length === 1) return 'root';
  const top = rel[0]!;
  if (top === 'types') return 'types';
  if (top === 'platform') return 'platform';
  if (top === 'db') return 'db';
  if (top === 'http') return 'http';
  if (top === 'routes') return 'routes';
  if (top === 'runtimes') return 'runtimes';
  if (top === 'app') return 'app';
  // Unknown top-level directories are treated as domains so adding one needs no
  // test change, while it still gets the domain rules.
  return 'domain';
}

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
  line: number;
}

function importsIn(file: string): ImportRef[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const refs: ImportRef[] = [];
  const push = (node: ts.Node, specifier: string, typeOnly: boolean): void => {
    refs.push({
      specifier,
      typeOnly,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text, node.importClause?.isTypeOnly ?? false);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node, node.moduleSpecifier.text, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      push(node, node.arguments[0]!.text, false);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return refs;
}

function resolveTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const withoutJs = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
  const base = path.resolve(path.dirname(fromFile), withoutJs);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (candidate.startsWith(srcDir + path.sep) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function violation(from: Bucket, to: Bucket, typeOnly: boolean): string | null {
  if (from === 'root' || from === 'app') return null;

  if (from === 'types') return to === 'types' ? null : 'types/ is a leaf and may only import types/';
  if (from === 'platform') {
    return to === 'platform' || to === 'types' ? null : 'platform/ must not depend on upper layers';
  }
  if (from === 'http') {
    return to === 'http' || to === 'platform' || to === 'types' || to === 'root'
      ? null
      : 'http/ may only import http/, platform/, types/, or the version root file';
  }
  if (from === 'db') {
    if (to === 'app') return typeOnly ? null : 'db/ may only type-import app/';
    return to === 'db' || to === 'platform' || to === 'types' || to === 'root'
      ? null
      : `db/ must not depend on ${to}/`;
  }
  if (from === 'runtimes') {
    if (to === 'app') return typeOnly ? null : 'runtimes/ may only type-import app/';
    return to === 'routes' ? 'runtimes/ must not depend on routes/' : null;
  }
  if (from === 'domain') {
    if (to === 'app') return typeOnly ? null : 'domains may only type-import app/';
    return to === 'routes' ? 'domains must not depend on routes/' : null;
  }
  if (from === 'routes') {
    if (to === 'app') return typeOnly ? null : 'routes/ may only type-import app/';
    return null;
  }
  return null;
}

describe('daemon source layout', () => {
  it('keeps only process entry and path-sensitive files at the src root', () => {
    const rootFiles = fs
      .readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    expect(rootFiles).toEqual(['index.ts', 'permission-hook.ts', 'version.ts']);
  });

  it('respects the layer dependency rules', () => {
    const problems: string[] = [];
    for (const file of walk(srcDir)) {
      const from = bucketOf(file);
      for (const ref of importsIn(file)) {
        const target = resolveTarget(file, ref.specifier);
        if (!target) continue;
        const to = bucketOf(target);
        const reason = violation(from, to, ref.typeOnly);
        if (reason) {
          problems.push(
            `${path.relative(srcDir, file)}:${ref.line} imports '${ref.specifier}' — ${reason}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
