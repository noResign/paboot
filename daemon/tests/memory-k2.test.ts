import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { KnowledgeStore } from '../src/knowledge/store';
import { MemoryKnowledgeIndexer } from '../src/memory/knowledge-index';
import { MemoryStore } from '../src/memory/store';
import { registerKnowledgeRoutes } from '../src/routes/knowledge';
import { registerMemoryRoutes } from '../src/routes/memory';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  dirs.push(dir);
  return dir;
}

function setup() {
  const db = new Db(':memory:');
  dbs.push(db);
  const dataDir = tmpDir('k2');
  const memory = new MemoryStore(dataDir);
  stores.push(memory);
  const knowledge = new KnowledgeStore(dataDir);
  const { workspace } = db.ensureLifeWorkspace(tmpDir('life'));
  const indexer = new MemoryKnowledgeIndexer(memory, knowledge);
  return { db, memory, knowledge, workspace, indexer };
}

describe('K2 knowledge mirror', () => {
  it('mirrors documents and chunks into search', () => {
    const { memory, knowledge, workspace, indexer } = setup();
    const doc = knowledge.create(workspace.id, {
      title: '登录重构',
      kind: 'tech_doc',
      body: '# 登录重构\n\n登录改用 JWT。\n\n## 约束\n\n必须兼容旧 token。',
    });
    const result = indexer.syncWorkspace(workspace.id);
    expect(result.indexed).toBe(1);

    const mirrored = memory.listDocuments(`workspace:${workspace.id}`);
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({
      id: doc.id,
      title: '登录重构',
      authority: 'curated',
      reviewStatus: 'confirmed',
    });
    expect(memory.listDocumentChunks(doc.id).length).toBeGreaterThan(0);

    const hits = memory.searchMemory({
      scopes: [`workspace:${workspace.id}`],
      query: '旧 token',
    });
    expect(hits.map((hit) => hit.kind)).toContain('document');
    expect(hits.find((hit) => hit.kind === 'document')?.refId).toBe(doc.id);
  });

  it('rebuilds chunks on edit and removes the mirror on delete', () => {
    const { memory, knowledge, workspace, indexer } = setup();
    const doc = knowledge.create(workspace.id, {
      title: '构建说明',
      kind: 'convention',
      body: '# 构建说明\n\n使用 Gradle 构建。',
    });
    indexer.syncWorkspace(workspace.id);
    expect(memory.searchMemory({ scopes: [`workspace:${workspace.id}`], query: 'Gradle' })).toHaveLength(1);

    knowledge.update(workspace.id, doc.id, { body: '# 构建说明\n\n改用 Maven 构建。' });
    indexer.syncWorkspace(workspace.id);
    expect(memory.searchMemory({ scopes: [`workspace:${workspace.id}`], query: 'Gradle' })).toHaveLength(0);
    expect(memory.searchMemory({ scopes: [`workspace:${workspace.id}`], query: 'Maven' })).toHaveLength(1);

    knowledge.remove(workspace.id, doc.id);
    indexer.syncWorkspace(workspace.id);
    expect(memory.listDocuments(`workspace:${workspace.id}`)).toHaveLength(0);
    expect(memory.searchMemory({ scopes: [`workspace:${workspace.id}`], query: 'Maven' })).toHaveLength(0);
  });

  it('maps unverified documents to derived authority', () => {
    const { memory, knowledge, workspace, indexer } = setup();
    const doc = knowledge.create(workspace.id, {
      title: '临时笔记',
      kind: 'note',
      body: '# 临时笔记\n\n先记一下。',
    });
    knowledge.verify(workspace.id, doc.id, false);
    indexer.syncWorkspace(workspace.id);
    expect(memory.getDocument(doc.id)?.authority).toBe('derived');
  });

  it('exposes document hits through the memory search API', async () => {
    const { db, memory, knowledge, workspace, indexer } = setup();
    const ctx = { db, memory, knowledge, knowledgeIndex: indexer } as unknown as AppContext;
    const app = express();
    app.use(express.json());
    registerKnowledgeRoutes(app, ctx);
    registerMemoryRoutes(app, ctx);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const created = await fetch(`${url}/api/workspaces/${workspace.id}/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '发布流程', kind: 'runbook', body: '# 发布流程\n\n先跑全量测试。' }),
    });
    const createdBody = (await created.json()) as { document: { id: string; path: string } };
    const found = await fetch(
      `${url}/api/memory/search?scope=workspace:${workspace.id}&q=${encodeURIComponent('全量测试')}`,
    );
    expect(found.status).toBe(200);
    const body = (await found.json()) as {
      hits: { kind: string; id: string; path?: string }[];
    };
    const hit = body.hits.find((item) => item.kind === 'document');
    expect(hit).toMatchObject({
      id: createdBody.document.id,
      path: createdBody.document.path,
    });
  });
});
