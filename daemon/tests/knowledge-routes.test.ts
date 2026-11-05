import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { requireRolePolicy } from '../src/http/auth';
import { knowledgeRoot } from '../src/knowledge/paths';
import { KnowledgeStore } from '../src/knowledge/store';
import { registerKnowledgeRoutes } from '../src/routes/knowledge';

const tempDirs: string[] = [];
const servers: import('node:http').Server[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  db: Db;
  knowledge: KnowledgeStore;
  workspaceId: string;
  dataDir: string;
}

async function startApi(role: 'operator' | 'agent' | 'server' = 'operator') {
  const dataDir = tempDir('paboot-kn-api-');
  const workspacePath = tempDir('paboot-kn-ws-');
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });
  const knowledge = new KnowledgeStore(dataDir);
  const ctx = { db, knowledge } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authRole = role;
    next();
  });
  app.use('/api', requireRolePolicy());
  registerKnowledgeRoutes(app, ctx);

  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, db, knowledge, workspaceId: workspace.id, dataDir } satisfies Harness & { base: string };
}

function seed(root: string, relative: string, body: string): void {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

describe('knowledge routes', () => {
  it('auto-lists recognised files as confirmed but unverified', async () => {
    const { base, dataDir, workspaceId } = await startApi();
    seed(knowledgeRoot(dataDir, workspaceId), 'knowledge/build.md', '# Build\n\nUse pnpm.');

    const response = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<Record<string, unknown>> };
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({
      kind: 'note',
      title: 'Build',
      reviewStatus: 'confirmed',
      authority: 'derived',
      path: 'knowledge/build.md',
    });
  });

  it('creates, reads, edits, verifies and deletes a document as operator', async () => {
    const { base, dataDir, workspaceId, db } = await startApi();
    const audit = vi.spyOn(db, 'audit');

    const created = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Build Notes', body: '# Build Notes\n\nUse pnpm.', kind: 'convention' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { document: Record<string, unknown> };
    const id = createdBody.document.id as string;
    expect(audit).toHaveBeenCalledWith('knowledge_create', expect.stringContaining(id));
    expect(createdBody.document).toMatchObject({
      kind: 'convention',
      reviewStatus: 'confirmed',
      authority: 'curated',
      path: 'knowledge/build-notes.md',
    });

    const detail = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge/${id}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { document: { body: string } }).document.body).toContain('pnpm');

    const updated = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '## Build Notes\n\nUse pnpm -r.', endId: 'android' }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { document: Record<string, unknown> }).document).toMatchObject({
      endId: 'android',
      path: 'ends/android/knowledge/build-notes.md',
      reviewStatus: 'confirmed',
    });
    expect(audit).toHaveBeenCalledWith('knowledge_update', expect.stringContaining(id));

    const unverified = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge/${id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: false }),
    });
    expect(unverified.status).toBe(200);
    expect(((await unverified.json()) as { document: Record<string, unknown> }).document).toMatchObject({
      reviewStatus: 'confirmed',
      authority: 'derived',
    });

    const verified = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge/${id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: true }),
    });
    expect(verified.status).toBe(200);
    expect(((await verified.json()) as { document: Record<string, unknown> }).document.authority).toBe(
      'curated',
    );
    expect(audit).toHaveBeenCalledWith('knowledge_verify', expect.stringContaining(id));

    const removed = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge/${id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(audit).toHaveBeenCalledWith('knowledge_delete', expect.stringContaining(id));
    const listed = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`);
    expect(((await listed.json()) as { documents: unknown[] }).documents).toEqual([]);
    expect(
      fs.existsSync(path.join(knowledgeRoot(dataDir, workspaceId), 'ends', 'android', 'knowledge', 'build-notes.md')),
    ).toBe(false);
    expect(fs.existsSync(path.join(knowledgeRoot(dataDir, workspaceId), 'ends'))).toBe(false);
  });

  it('keeps reads open and writes closed to agent / server tokens', async () => {
    const { base, workspaceId } = await startApi('agent');
    const list = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`);
    expect(list.status).toBe(200);
    const write = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', body: '# X' }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe('forbidden');

    const serverHarness = await startApi('server');
    const serverRead = await fetch(
      `${serverHarness.base}/api/workspaces/${serverHarness.workspaceId}/knowledge`,
    );
    expect(serverRead.status).toBe(403);
  });

  it('filters and rejects unknown enum values', async () => {
    const { base, dataDir, workspaceId } = await startApi();
    seed(knowledgeRoot(dataDir, workspaceId), 'knowledge/auto.md', '# Auto\n\nScanned.');
    await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Build', body: '# Build\n\nGradle JDK.', kind: 'convention' }),
    });
    await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Auth', body: '# Auth\n\nJWT.', kind: 'decision', endId: 'android' }),
    });

    const byKind = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?kind=convention`);
    expect(((await byKind.json()) as { documents: Array<{ title: string }> }).documents.map((d) => d.title)).toEqual([
      'Build',
    ]);
    const byEnd = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?endId=android`);
    expect(((await byEnd.json()) as { documents: Array<{ title: string }> }).documents.map((d) => d.title)).toEqual([
      'Auth',
    ]);
    const byQuery = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?q=jwt`);
    expect(((await byQuery.json()) as { documents: Array<{ title: string }> }).documents.map((d) => d.title)).toEqual([
      'Auth',
    ]);
    const unverified = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?verified=false`);
    expect(
      ((await unverified.json()) as { documents: Array<{ title: string }> }).documents.map((d) => d.title),
    ).toEqual(['Auto']);
    const verified = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?verified=true`);
    expect(
      ((await verified.json()) as { documents: Array<{ title: string }> }).documents.map((d) => d.title).sort(),
    ).toEqual(['Auth', 'Build']);

    const badKind = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?kind=nope`);
    expect(badKind.status).toBe(400);
    const badStatus = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?status=unknown`);
    expect(badStatus.status).toBe(400);
    const badVerified = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge?verified=maybe`);
    expect(badVerified.status).toBe(400);
  });

  it('exports a zip and 404s on an unknown workspace', async () => {
    const { base, workspaceId } = await startApi();
    await fetch(`${base}/api/workspaces/${workspaceId}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Build', body: '# Build\n\nExport me.' }),
    });

    const response = await fetch(`${base}/api/workspaces/${workspaceId}/knowledge/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(bytes.includes(Buffer.from('Export me.'))).toBe(true);

    const missing = await fetch(`${base}/api/workspaces/does-not-exist/knowledge`);
    expect(missing.status).toBe(404);
  });
});
