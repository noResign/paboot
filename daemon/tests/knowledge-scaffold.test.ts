import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { buildKnowledgeSections } from '../src/knowledge/index';
import { scaffoldWorkspaceKnowledge } from '../src/knowledge/scaffold';
import { KnowledgeStore } from '../src/knowledge/store';
import { extraDirsForRun } from '../src/runs/run-service';
import { registerWorkspaceRoutes } from '../src/routes/workspaces';

const dirs: string[] = [];
const dbs: Db[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${prefix}-`));
  dirs.push(dir);
  return dir;
}

describe('workspace knowledge scaffolding', () => {
  it('creates a verified WORKSPACE.md whose summary is its first paragraph', () => {
    const store = new KnowledgeStore(tmpDir('knowledge-scaffold'));
    const created = scaffoldWorkspaceKnowledge(store, 'ws-1');

    expect(created).toEqual(['WORKSPACE.md']);
    const docs = store.list('ws-1');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: 'WORKSPACE.md',
      title: '工作区说明',
      summary: '本工作区的目标、边界、主要入口和必须遵守的约定。',
      authority: 'curated',
      reviewStatus: 'confirmed',
    });
    // It is a real document, so it is injected right away.
    expect(store.confirmed('ws-1')).toHaveLength(1);
    expect(buildKnowledgeSections(store.root('ws-1'), store.confirmed('ws-1'))[0]?.content).toContain(
      '工作区说明',
    );
  });

  it('keeps user content when the scaffold runs again', () => {
    const store = new KnowledgeStore(tmpDir('knowledge-scaffold-edit'));
    scaffoldWorkspaceKnowledge(store, 'ws-1');
    const doc = store.list('ws-1')[0]!;
    store.update('ws-1', doc.id, { body: '# 工作区说明\n\n真实描述。\n' });

    expect(scaffoldWorkspaceKnowledge(store, 'ws-1')).toEqual([]);
    expect(store.get('ws-1', doc.id).body).toContain('真实描述');
  });

  it('leaves conventions/knowledge/requirements to on-demand creation', () => {
    const store = new KnowledgeStore(tmpDir('knowledge-scaffold-paths'));
    scaffoldWorkspaceKnowledge(store, 'ws-1');
    const created = store.create('ws-1', {
      title: '踩坑',
      body: '正文',
      kind: 'gotcha',
    });
    expect(created.path).toMatch(/^knowledge\//);
  });

  it('passes the dev knowledge root to runtimes as an extra directory', () => {
    const db = new Db(':memory:');
    dbs.push(db);
    const workspacePath = tmpDir('knowledge-extra-ws');
    const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });
    const store = new KnowledgeStore(tmpDir('knowledge-extra-data'));
    const session = db.createSession({
      id: 's-1',
      runtime: 'builtin',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    const ctx = { db, knowledge: store } as unknown as AppContext;

    expect(extraDirsForRun(ctx, session, workspace)).toContain(store.root(workspace.id));

    const { workspace: life } = db.ensureLifeWorkspace(tmpDir('knowledge-extra-life'));
    const lifeSession = db.createSession({
      id: 's-life',
      runtime: 'builtin',
      workspaceId: life.id,
      permissionMode: 'ask',
      cwd: life.path,
    });
    expect(extraDirsForRun(ctx, lifeSession, life)).not.toContain(store.root(life.id));
  });

  it('scaffolds a workspace created through POST /api/workspaces', async () => {
    const db = new Db(':memory:');
    dbs.push(db);
    const store = new KnowledgeStore(tmpDir('knowledge-scaffold-route'));
    const ctx = { db, knowledge: store } as unknown as AppContext;
    const app = express();
    app.use(express.json());
    registerWorkspaceRoutes(app, ctx);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'demo', path: tmpDir('knowledge-scaffold-target') }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { workspace: { id: string } };
    const docs = store.list(body.workspace.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ path: 'WORKSPACE.md', authority: 'curated' });
  });
});
