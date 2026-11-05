import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildKnowledgeSections } from '../src/knowledge/index';
import { readManifest, writeManifest } from '../src/knowledge/manifest';
import { knowledgeRoot } from '../src/knowledge/paths';
import { KnowledgeStore } from '../src/knowledge/store';
import { KnowledgeError } from '../src/knowledge/types';

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-kn-store-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relative: string, body: string): void {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('KnowledgeStore.reconcile', () => {
  it('auto-registers recognised files as confirmed but unverified', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'WORKSPACE.md', '# Workspace\n\nMain conventions.');
    writeFile(root, 'conventions/build.md', '# Build\n\nRun pnpm build.');
    writeFile(root, 'knowledge/auth.md', '# Auth\n\nJWT lives in the gateway.');
    writeFile(root, 'ends/android/CONVENTIONS.md', '# Android\n\nKotlin only.');
    writeFile(root, 'requirements/r1/goal.md', '# Goal\n\nShip K0.');
    writeFile(root, 'notes/ignored.md', '# Ignored');
    writeFile(root, 'knowledge/not-markdown.txt', 'ignored');

    const store = new KnowledgeStore(dataDir);
    const docs = store.reconcile('ws-1');

    expect(docs).toHaveLength(5);
    expect(docs.every((doc) => doc.reviewStatus === 'confirmed')).toBe(true);
    expect(docs.every((doc) => doc.authority === 'derived')).toBe(true);
    expect(docs.every((doc) => doc.origin === 'user')).toBe(true);
    // 5 scanned files, but one belongs to an end; `confirmed()` without an end
    // returns workspace-level pointers only.
    expect(store.confirmed('ws-1')).toHaveLength(4);

    const byPath = new Map(docs.map((doc) => [doc.path, doc]));
    expect(byPath.get('WORKSPACE.md')?.kind).toBe('workspace_context');
    expect(byPath.get('WORKSPACE.md')?.title).toBe('Workspace');
    expect(byPath.get('conventions/build.md')?.summary).toBe('Run pnpm build.');
    expect(byPath.get('ends/android/CONVENTIONS.md')?.endId).toBe('android');
    expect(byPath.get('requirements/r1/goal.md')?.kind).toBe('requirement');
    expect(byPath.has('notes/ignored.md')).toBe(false);
  });

  it('marks a document verified, and an external edit only resets the marker', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/auth.md', '# Auth\n\nJWT.');
    const store = new KnowledgeStore(dataDir);

    const [doc] = store.reconcile('ws-1');
    const verified = store.verify('ws-1', doc!.id, true);
    expect(verified.reviewStatus).toBe('confirmed');
    expect(verified.authority).toBe('curated');
    expect(store.confirmed('ws-1').map((item) => item.id)).toEqual([doc!.id]);

    writeFile(root, 'knowledge/auth.md', '# Auth\n\nChanged outside the daemon.');
    const afterEdit = store.reconcile('ws-1');
    expect(afterEdit[0]?.reviewStatus).toBe('confirmed');
    expect(afterEdit[0]?.authority).toBe('derived');
    // Auto-included even though the human verification no longer applies.
    expect(store.confirmed('ws-1').map((item) => item.id)).toEqual([doc!.id]);
  });

  it('is idempotent across repeated scans', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/a.md', '# A\n\nBody.');
    const store = new KnowledgeStore(dataDir);

    const first = store.reconcile('ws-1');
    const second = store.reconcile('ws-1');
    expect(second.map((doc) => doc.id)).toEqual(first.map((doc) => doc.id));
    expect(second).toHaveLength(1);
  });

  it('marks a vanished file missing and blocks verification', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/a.md', '# A\n\nBody.');
    const store = new KnowledgeStore(dataDir);
    const [doc] = store.reconcile('ws-1');

    fs.rmSync(path.join(root, 'knowledge', 'a.md'));
    const [missing] = store.reconcile('ws-1');
    expect(missing?.reviewStatus).toBe('missing');
    expect(store.get('ws-1', doc!.id).body).toBe('');
    expect(() => store.verify('ws-1', doc!.id, true)).toThrow(KnowledgeError);
  });
});

describe('KnowledgeStore writes', () => {
  it('creates a confirmed document and keeps the slug unique', () => {
    const dataDir = tempDataDir();
    const store = new KnowledgeStore(dataDir);

    const first = store.create('ws-1', { title: 'Build Notes', body: '# Build Notes\n\nUse pnpm build.' });
    expect(first.path).toBe('knowledge/build-notes.md');
    expect(first.reviewStatus).toBe('confirmed');
    expect(first.authority).toBe('curated');
    expect(first.summary).toBe('Use pnpm build.');
    expect(fs.readFileSync(first.absolutePath, 'utf8')).toContain('pnpm build');

    const second = store.create('ws-1', { title: 'Build Notes', body: '# Build Notes 2' });
    expect(second.path).toBe('knowledge/build-notes-2.md');
  });

  it('updates content, keeps it confirmed, and moves it when endId changes', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    const store = new KnowledgeStore(dataDir);
    const created = store.create('ws-1', { title: 'Build Notes', body: '# Build Notes\n\nOld.' });

    const updated = store.update('ws-1', created.id, { body: '## Build Notes\n\nNew body.' });
    expect(updated.reviewStatus).toBe('confirmed');
    expect(updated.summary).toBe('New body.');
    expect(updated.contentHash).not.toBe(created.contentHash);

    const moved = store.update('ws-1', created.id, { endId: 'android' });
    expect(moved.path).toBe('ends/android/knowledge/build-notes.md');
    expect(moved.endId).toBe('android');
    expect(fs.existsSync(path.join(root, 'knowledge', 'build-notes.md'))).toBe(false);
    expect(fs.readFileSync(moved.absolutePath, 'utf8')).toContain('New body.');
  });

  it('toggles the human-verification marker without affecting inclusion', () => {
    const dataDir = tempDataDir();
    const store = new KnowledgeStore(dataDir);
    const created = store.create('ws-1', { title: 'Draft', body: '# Draft\n\nMaybe.' });
    expect(created.authority).toBe('curated');

    const unverified = store.verify('ws-1', created.id, false);
    expect(unverified.reviewStatus).toBe('confirmed');
    expect(unverified.authority).toBe('derived');
    expect(store.confirmed('ws-1').map((doc) => doc.id)).toEqual([created.id]);

    const verified = store.verify('ws-1', created.id, true);
    expect(verified.authority).toBe('curated');
    expect(store.confirmed('ws-1').map((doc) => doc.id)).toEqual([created.id]);
  });

  it('permanently deletes a document and prunes empty end directories', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    const store = new KnowledgeStore(dataDir);
    const created = store.create('ws-1', {
      title: 'Old',
      body: '# Old\n\nGone.',
      endId: 'android',
    });

    store.remove('ws-1', created.id);
    expect(store.list('ws-1')).toEqual([]);
    expect(fs.existsSync(path.join(root, 'ends', 'android'))).toBe(false);
    expect(fs.existsSync(path.join(root, '_trash'))).toBe(false);
  });

  it('filters by kind, status, verification, end and full-text query', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/auto.md', '# Auto\n\nScanned by someone else.');
    const store = new KnowledgeStore(dataDir);
    const build = store.create('ws-1', { title: 'Build', body: '# Build\n\nGradle needs JDK 21.', kind: 'convention' });
    store.create('ws-1', { title: 'Auth', body: '# Auth\n\nJWT tokens.', kind: 'decision', endId: 'android' });

    expect(store.list('ws-1', { kind: 'convention' }).map((doc) => doc.id)).toEqual([build.id]);
    expect(store.list('ws-1', { status: 'confirmed' })).toHaveLength(3);
    expect(store.list('ws-1', { verified: true }).map((doc) => doc.title).sort()).toEqual(['Auth', 'Build']);
    expect(store.list('ws-1', { verified: false }).map((doc) => doc.title)).toEqual(['Auto']);
    expect(store.list('ws-1', { endId: 'android' }).map((doc) => doc.title)).toEqual(['Auth']);
    expect(store.list('ws-1', { endId: 'workspace' }).map((doc) => doc.title).sort()).toEqual(['Auto', 'Build']);
    expect(store.list('ws-1', { q: 'jdk' }).map((doc) => doc.title)).toEqual(['Build']);
    expect(store.list('ws-1', { q: 'missing' })).toEqual([]);
  });

  it('migrates legacy pending / rejected entries on the next scan', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/legacy.md', '# Legacy\n\nOld state.');
    const store = new KnowledgeStore(dataDir);
    store.reconcile('ws-1');

    const manifest = readManifest(root);
    manifest.documents['knowledge/legacy.md']!.reviewStatus = 'pending';
    writeManifest(root, manifest);

    const [doc] = store.reconcile('ws-1');
    expect(doc?.reviewStatus).toBe('confirmed');
    expect(doc?.authority).toBe('derived');
    expect(store.confirmed('ws-1')).toHaveLength(1);
  });
});

describe('KnowledgeStore export / workspace deletion', () => {
  it('exports documents and the manifest as a zip', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'WORKSPACE.md', '# Workspace\n\nHello.');
    const store = new KnowledgeStore(dataDir);
    store.create('ws-1', { title: 'Build', body: '# Build\n\nExport me.' });

    const zip = store.exportZip('ws-1');
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.includes(Buffer.from('WORKSPACE.md'))).toBe(true);
    expect(zip.includes(Buffer.from('knowledge/.meta.json'))).toBe(true);
    expect(zip.includes(Buffer.from('Export me.'))).toBe(true);
  });

  it('deletes the whole store on workspace deletion', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/a.md', '# A\n\nBody.');
    const store = new KnowledgeStore(dataDir);

    const removed = store.deleteWorkspaceData('ws-1');
    expect(removed).toBe(root);
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'workspaces', '_trash'))).toBe(false);
  });
});

describe('buildKnowledgeSections', () => {
  it('emits workspace, end and requirement pointer sections with absolute paths', () => {
    const dataDir = tempDataDir();
    const root = knowledgeRoot(dataDir, 'ws-1');
    writeFile(root, 'knowledge/auto.md', '# Auto\n\nCollected without review.');
    const store = new KnowledgeStore(dataDir);
    const workspaceDoc = store.create('ws-1', { title: 'Build', body: '# Build\n\nBody.', kind: 'convention' });
    const endDoc = store.create('ws-1', {
      title: 'Android Build',
      body: '# Android Build\n\nBody.',
      kind: 'tech_doc',
      endId: 'android',
    });
    const requirement = store.create('ws-1', {
      title: 'K0',
      body: '# K0\n\nShip knowledge.',
      kind: 'requirement',
    });

    const sections = buildKnowledgeSections(root, store.confirmed('ws-1', 'android'));
    expect(sections.map((section) => [section.kind, section.source])).toEqual([
      ['workspace', 'knowledge:workspace'],
      ['end', 'knowledge:end:android'],
      ['requirements', 'knowledge:requirements'],
    ]);
    expect(sections[0]!.content).toContain(`- [convention] Build — ${workspaceDoc.absolutePath}`);
    expect(sections[0]!.content).toContain('- [note] Auto（未核验） — ');
    expect(sections[1]!.content).toContain(`- [tech_doc] Android Build — ${endDoc.absolutePath}`);
    expect(sections[2]!.content).toContain(`- [requirement] K0 — ${requirement.absolutePath}`);
  });
});
