import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db, type SessionRow, type WorkspaceRow } from '../src/db/db';
import { MemoryStore } from '../src/memory/store';
import { captureRunMessages } from '../src/memory/ingest';
import { registerMemoryRoutes } from '../src/routes/memory';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

async function setup(): Promise<{
  url: string;
  db: Db;
  store: MemoryStore;
  workspace: WorkspaceRow;
  endId: string;
  session: SessionRow;
  ctx: AppContext;
}> {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace, end } = db.ensureLifeWorkspace(tmpDir('life'));
  const session = db.createSession({
    id: 's-life',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  db.addMessage(session.id, 'user', '我搬到上海了');

  const ctx = {
    db,
    memory: store,
    providers: {
      list: async () => [
        {
          id: 'fake',
          hasApiKey: true,
          models: [{ id: 'fake-1' }, { id: 'from-settings' }],
        },
      ],
    },
    config: { memoryModel: 'fake:fake-1' },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerMemoryRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, db, store, workspace, endId: end.id, session, ctx };
}

function claimIn(store: MemoryStore, workspaceId: string, endId: string, summary = '住在上海') {
  return store.insertClaim({
    scope: `workspace:${workspaceId}`,
    endId,
    predicate: 'lives_in',
    objectText: '上海',
    kind: 'fact',
    summary,
    confidence: 0.8,
    importance: 0.8,
  });
}

describe('memory routes (M0)', () => {
  it('returns the brief and claim list for a life session', async () => {
    const { url, store, workspace, endId, session } = await setup();
    claimIn(store, workspace.id, endId);

    const brief = await fetch(`${url}/api/memory/brief?sessionId=${session.id}`);
    expect(brief.status).toBe(200);
    expect((await brief.json()) as { markdown: string }).toMatchObject({
      markdown: expect.stringContaining('住在上海'),
    });

    const claims = await fetch(`${url}/api/memory/claims?sessionId=${session.id}`);
    expect(claims.status).toBe(200);
    const body = (await claims.json()) as { claims: { id: string; evidence: unknown[] }[] };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]?.evidence).toEqual([]);
  });

  it('requires a scope and rejects dev workspaces in M0', async () => {
    const { url, db } = await setup();
    const missing = await fetch(`${url}/api/memory/claims`);
    expect(missing.status).toBe(400);

    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag');
    const rejected = await fetch(`${url}/api/memory/claims?scope=workspace:${dev!.id}`);
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe('memory_not_enabled');
  });

  it('corrects a claim and marks it user_confirmed', async () => {
    const { url, store, workspace, endId, session } = await setup();
    const claim = claimIn(store, workspace.id, endId);

    const response = await fetch(`${url}/api/memory/claims/${claim.id}?sessionId=${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectText: '杭州' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claim: { authority: string; confidence: number; objectText: string } };
    expect(body.claim).toMatchObject({ authority: 'user_confirmed', confidence: 1, objectText: '杭州' });
  });

  it('does not expose a claim from another scope', async () => {
    const { url, store, endId, session } = await setup();
    const other = claimIn(store, 'another-workspace', endId);
    const response = await fetch(`${url}/api/memory/claims/${other.id}?sessionId=${session.id}`);
    expect(response.status).toBe(404);
  });

  it('never exposes secret claims through the claims API', async () => {
    const { url, store, workspace, endId, session } = await setup();
    const secret = store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId,
      predicate: 'profile',
      objectText: '银行卡密码',
      kind: 'profile',
      summary: '银行卡密码是 123456',
      sensitivity: 'secret',
      confidence: 1,
      importance: 1,
    });

    const list = await fetch(`${url}/api/memory/claims?sessionId=${session.id}`);
    expect(((await list.json()) as { claims: unknown[] }).claims).toEqual([]);
    const detail = await fetch(`${url}/api/memory/claims/${secret.id}?sessionId=${session.id}`);
    expect(detail.status).toBe(404);
  });

  it('forgets a claim and tombstones its evidence', async () => {
    const { url, db, store, workspace, endId, session } = await setup();
    const source = store.insertSource({
      scope: `workspace:${workspace.id}`,
      workspaceId: workspace.id,
      endId,
      kind: 'message',
      sourceTable: 'messages',
      sessionId: session.id,
      messageId: 1,
      occurredAt: Date.now(),
      content: '我搬到上海了',
    }).source;
    const claim = store.insertClaim(
      {
        scope: `workspace:${workspace.id}`,
        endId,
        predicate: 'lives_in',
        objectText: '上海',
        kind: 'fact',
        summary: '住在上海',
        confidence: 0.8,
        importance: 0.8,
      },
      [{ sourceId: source.id, quote: '我搬到上海了' }],
    );

    const response = await fetch(`${url}/api/memory/claims/${claim.id}?sessionId=${session.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(store.getClaim(claim.id)).toBeUndefined();
    expect(store.hasTombstone(`workspace:${workspace.id}`, endId, source.contentHash)).toBe(true);

    const messageId = db.listMessages(session.id)[0]!.id;
    const remembered = await fetch(`${url}/api/memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, messageId }),
    });
    expect(remembered.status).toBe(409);
    expect(((await remembered.json()) as { code: string }).code).toBe('forgotten_content');
  });

  it('remembers a message and reports status', async () => {
    const { url, db, store, workspace, session } = await setup();
    const messageId = db.listMessages(session.id)[0]!.id;

    const response = await fetch(`${url}/api/memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, messageId }),
    });
    expect(response.status).toBe(200);
    expect(store.countSources('pending', `workspace:${workspace.id}`)).toBe(1);

    const status = await fetch(`${url}/api/memory/status?sessionId=${session.id}`);
    expect(status.status).toBe(200);
    expect((await status.json()) as {
      pendingSources: number;
      extractionModel: string;
      modelAvailable: boolean;
    }).toMatchObject({
      pendingSources: 1,
      extractionModel: 'fake:fake-1',
      modelAvailable: true,
    });

    // The settings-table pick wins over the env fallback shown in ctx.config.
    db.setSetting('memory_model', 'fake:from-settings');
    const updated = (await (
      await fetch(`${url}/api/memory/status?sessionId=${session.id}`)
    ).json()) as { extractionModel: string; modelAvailable: boolean };
    expect(updated.extractionModel).toBe('fake:from-settings');
    expect(updated.modelAvailable).toBe(true);
  });

  it('does not backfill messages sent while memory was off', async () => {
    const { url, db, store, workspace, session } = await setup();

    const off = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, mode: 'off' }),
    });
    expect(off.status).toBe(200);
    db.addMessage(session.id, 'user', '关闭记忆期间说的话');

    const on = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, mode: 'normal' }),
    });
    expect(on.status).toBe(200);
    db.addMessage(session.id, 'user', '重新开启后说的话');

    const current = db.getSession(session.id) as SessionRow;
    const captured = captureRunMessages({
      store,
      session: current,
      workspace,
      ends: db.listEnds(workspace.id),
      messages: db.listMessages(session.id),
      runId: 'r-after-memory-on',
    });
    expect(captured).toBe(1);
    expect(store.listSources(`workspace:${workspace.id}`).map((item) => item.content)).toEqual([
      '重新开启后说的话',
    ]);
  });

  it('switches a session memory mode', async () => {
    const { url, db, session } = await setup();
    const response = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, mode: 'off' }),
    });
    expect(response.status).toBe(200);
    expect(db.getSession(session.id)?.memory_mode).toBe('off');
  });
});
