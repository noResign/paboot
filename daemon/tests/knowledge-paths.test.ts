import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateDocumentPath,
  classifyDocumentPath,
  isSafeRelativePath,
  knowledgeRoot,
  resolveDocumentFile,
  slugify,
} from '../src/knowledge/paths';
import { KnowledgeError } from '../src/knowledge/types';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-kn-paths-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('knowledge paths', () => {
  it('builds the workspace store under the daemon data dir', () => {
    expect(knowledgeRoot('/data', 'ws-1')).toBe(path.join('/data', 'workspaces', 'ws-1'));
    expect(() => knowledgeRoot('/data', '../escape')).toThrow(KnowledgeError);
    expect(() => knowledgeRoot('/data', '')).toThrow(KnowledgeError);
  });

  it('slugifies titles and falls back for symbols-only titles', () => {
    expect(slugify('Gradle 构建 JDK21')).toBe('gradle-构建-jdk21');
    expect(slugify('  Build & Release  ')).toBe('build-release');
    expect(slugify('!!!')).toBe('untitled');
  });

  it('rejects unsafe manifest keys', () => {
    expect(isSafeRelativePath('knowledge/build.md')).toBe(true);
    expect(isSafeRelativePath('requirements/a/b.md')).toBe(true);
    for (const value of ['', '/abs.md', '../x.md', 'a/../b.md', 'a//b.md', '.hidden/x.md', 'a\\b.md']) {
      expect(isSafeRelativePath(value)).toBe(false);
    }
  });

  it('recognises only the documented layout', () => {
    expect(classifyDocumentPath('WORKSPACE.md')).toEqual({ kind: 'workspace_context', endId: null });
    expect(classifyDocumentPath('conventions/build.md')).toEqual({ kind: 'convention', endId: null });
    expect(classifyDocumentPath('knowledge/auth.md')).toEqual({ kind: 'note', endId: null });
    expect(classifyDocumentPath('ends/android/CONVENTIONS.md')).toEqual({
      kind: 'convention',
      endId: 'android',
    });
    expect(classifyDocumentPath('ends/android/knowledge/build.md')).toEqual({
      kind: 'tech_doc',
      endId: 'android',
    });
    expect(classifyDocumentPath('requirements/r1/goal.md')).toEqual({
      kind: 'requirement',
      endId: null,
    });
    expect(classifyDocumentPath('notes/random.md')).toBeNull();
    expect(classifyDocumentPath('ends/bad id/knowledge/x.md')).toBeNull();
  });

  it('refuses traversal and symlink escapes', () => {
    const dataDir = tempDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
    expect(() => resolveDocumentFile(root, '../outside.md')).toThrow(KnowledgeError);

    const outsideDir = tempDir();
    const outsideFile = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(root, 'knowledge', 'link.md'));
    expect(() => resolveDocumentFile(root, 'knowledge/link.md')).toThrow(KnowledgeError);
  });

  it('allocates a unique filename when the slug already exists', () => {
    const dataDir = tempDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    fs.mkdirSync(root, { recursive: true });
    expect(allocateDocumentPath(root, 'Build', null)).toBe('knowledge/build.md');
    fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(root, 'knowledge', 'build.md'), 'first');
    expect(allocateDocumentPath(root, 'Build', null)).toBe('knowledge/build-2.md');
  });
});
