import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { MemoryStore } from '../src/memory/store';
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
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace: life, end } = db.ensureLifeWorkspace(tmpDir('life'));
  db.addMessage(
    db.createSession({
      id: 's-life',
      runtime: 'claude',
      workspaceId: life.id,
      permissionMode: 'ask',
      cwd: life.path,
    }).id,
    'user',
    '我搬到上海了',
  );
  return { db, store, life, lifeEndId: end.id };
}

function source(store: MemoryStore, scope: `workspace:${string}`, content: string, sensitivity: 'normal' | 'private' | 'secret' = 'normal') {
  return store.insertSource({
    scope,
    endId: null,
    kind: 'message',
    sourceTable: 'messages',
    sessionId: 's-1',
    occurredAt: Date.now(),
    content,
    sensitivity,
  }).source;
}

function claim(store: MemoryStore, scope: `workspace:${string}`, summary: string) {
  return store.insertClaim({
    scope,
    endId: null,
    predicate: 'lives_in',
    objectText: '上海',
    kind: 'fact',
    summary,
    confidence: 0.8,
    importance: 0.8,
  });
}

describe('memory search (D31)', () => {
  it('matches 3+ character CJK via FTS and 1-2 characters via LIKE', () => {
    const { store, life } = setup();
    const scope = `workspace:${life.id}` as const;
    const src = source(store, scope, '我搬到上海了');
    const fact = claim(store, scope, '住在上海');

    const long = store.searchMemory({ scopes: [scope], query: '上海' });
    expect(long.map((hit) => hit.refId).sort()).toEqual([src.id, fact.id].sort());

    const short = store.searchMemory({ scopes: [scope], query: '搬' });
    expect(short.map((hit) => hit.refId)).toEqual([src.id]);
  });

  it('falls back to OR over terms and respects the scope list', () => {
    const { store, life } = setup();
    const scope = `workspace:${life.id}` as const;
    source(store, scope, '上海天气不错');
    source(store, scope, '今天搬家');
    source(store, `workspace:other`, '上海另一个工作区');

    const hits = store.searchMemory({ scopes: [scope], query: '上海 搬家' });
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.scope === scope)).toBe(true);
  });

  it('updates the index after correction and forget', () => {
    const { store, life } = setup();
    const scope = `workspace:${life.id}` as const;
    const fact = claim(store, scope, '住在上海');
    expect(store.searchMemory({ scopes: [scope], query: '上海' })).toHaveLength(1);

    store.correctClaim(fact.id, { objectText: '杭州', summary: '住在杭州' });
    expect(store.searchMemory({ scopes: [scope], query: '杭州' })).toHaveLength(1);
    expect(store.searchMemory({ scopes: [scope], query: '上海' })).toHaveLength(0);

    store.forgetClaim(fact.id);
    expect(store.searchMemory({ scopes: [scope], query: '杭州' })).toHaveLength(0);
  });

  it('never indexes secret content', () => {
    const { store, life } = setup();
    const scope = `workspace:${life.id}` as const;
    source(store, scope, '银行卡密码是 123456', 'secret');
    expect(store.searchMemory({ scopes: [scope], query: '银行卡' })).toHaveLength(0);
  });
});

describe('memory search routes', () => {
  async function harness() {
    const { db, store, life } = setup();
    const ctx = { db, memory: store } as unknown as AppContext;
    const app = express();
    app.use(express.json());
    registerMemoryRoutes(app, ctx);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, db, store, life };
  }

  it('returns claims and sources, filters secret and cross-private, and exposes L0', async () => {
    const { url, db, store, life } = await harness();
    const scope = `workspace:${life.id}` as const;
    const fact = claim(store, scope, '住在上海');
    const src = source(store, scope, '我搬到上海了');
    const privateSrc = source(store, scope, '私密上海信息', 'private');
    source(store, scope, '绝密上海信息', 'secret');

    const session = db.createSession({
      id: 's-search',
      runtime: 'claude',
      workspaceId: life.id,
      permissionMode: 'ask',
      cwd: life.path,
    });
    const response = await fetch(
      `${url}/api/memory/search?sessionId=${session.id}&q=${encodeURIComponent('上海')}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hits: { kind: string; id: string }[] };
    expect(body.hits.map((hit) => hit.id).sort()).toEqual(
      [fact.id, src.id, privateSrc.id].sort(),
    );
    expect(body.hits.every((hit) => hit.kind === 'claim' || hit.kind === 'source')).toBe(true);

    const detail = await fetch(`${url}/api/memory/sources/${src.id}?sessionId=${session.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ source: { content: '我搬到上海了' } });
  });

  it('requires a query and hides a source outside the read scopes', async () => {
    const { url, store, life } = await harness();
    const scope = `workspace:${life.id}` as const;
    const response = await fetch(`${url}/api/memory/search?scope=${scope}`);
    expect(response.status).toBe(400);

    const other = source(store, 'workspace:other', '另一个工作区的上海');
    const denied = await fetch(`${url}/api/memory/sources/${other.id}?scope=${scope}`);
    expect(denied.status).toBe(404);
  });
});
