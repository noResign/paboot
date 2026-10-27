import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { registerChatRoutes } from '../src/routes/chat';
import { getActiveRun, registerActiveRun } from '../src/runtimes/active-runs';

const dbs: Db[] = [];
const servers: Server[] = [];
/** Resolvers for the fake runs, so each test can de-register what it started. */
const settle: Array<() => void> = [];

afterEach(async () => {
  for (const done of settle.splice(0)) done();
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const db of dbs.splice(0)) db.close();
});

function openDb(): Db {
  const db = new Db(':memory:');
  dbs.push(db);
  return db;
}

/**
 * Register an in-flight run for `sessionId` that never finishes on its own. The
 * DB row matters: `runningRunBySession` resolves session ids through `getRun`.
 */
function registerRun(db: Db, runId: string, sessionId: string): void {
  db.createRun({ id: runId, sessionId, runtime: 'claude', model: null, prompt: 'hi', status: 'running' });
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  registerActiveRun({ id: runId, promise, cancel: () => {} });
  settle.push(() => {
    db.updateRun(runId, { status: 'succeeded', endedAt: Date.now() });
    resolve();
  });
}

/**
 * A context whose runtime is present but unavailable, so any request that gets
 * *past* the session guard stops at a deterministic 503 — which is what makes
 * the differential assertions below meaningful.
 */
function makeCtx(db: Db): AppContext {
  return {
    db,
    registry: {
      // A known runtime (has a driver) that is unavailable, so a request past
      // the session guard stops at a deterministic 503.
      driver: () => ({}),
      detection: () => ({ available: false }),
      detect: async () => ({ available: false }),
    },
  } as unknown as AppContext;
}

async function startApi(db: Db): Promise<string> {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, makeCtx(db));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function sendChat(base: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A default workspace plus one session, which is all the guard needs. */
function seedSession(db: Db, sessionId: string): void {
  const workspace = db.seedDefaultWorkspace(process.cwd(), 'ask');
  if (!workspace) throw new Error('expected a seeded workspace');
  db.createSession({ id: sessionId, runtime: 'claude', workspaceId: workspace.id, permissionMode: 'ask', cwd: workspace.path });
}

describe('POST /api/chat session guard', () => {
  // 两个 run 并发会 `--resume` 同一个 native session id，也就是往同一份 Claude 会话记录里写。
  it('refuses a second run while the session is busy', async () => {
    const db = openDb();
    seedSession(db, 's-1');
    registerRun(db, 'r-1', 's-1');
    const base = await startApi(db);

    const res = await sendChat(base, { sessionId: 's-1', prompt: 'second' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_busy');
    expect(res.body.runId).toBe('r-1');
  });

  // 差分断言：同一个请求在空闲会话上走到 503（runtime 不可用），在忙会话上被拦成 409，
  // 说明守卫排在 runtime 探测之前——探测会 spawn CLI，不该为必然失败的请求付这个代价。
  it('rejects before probing the runtime', async () => {
    const db = openDb();
    seedSession(db, 's-1');
    seedSession(db, 's-2');
    registerRun(db, 'r-1', 's-1');
    const base = await startApi(db);

    expect((await sendChat(base, { sessionId: 's-1', prompt: 'x' })).status).toBe(409);
    expect((await sendChat(base, { sessionId: 's-2', prompt: 'x' })).status).toBe(503);
  });

  it('lets the session through once the run has finished', async () => {
    const db = openDb();
    seedSession(db, 's-1');
    registerRun(db, 'r-1', 's-1');
    const base = await startApi(db);

    expect((await sendChat(base, { sessionId: 's-1', prompt: 'x' })).status).toBe(409);

    for (const done of settle.splice(0)) done();
    await new Promise((resolve) => setImmediate(resolve));
    expect(getActiveRun('r-1')).toBeUndefined();

    expect((await sendChat(base, { sessionId: 's-1', prompt: 'x' })).status).toBe(503);
  });

  it('leaves other sessions alone', async () => {
    const db = openDb();
    seedSession(db, 's-1');
    seedSession(db, 's-2');
    registerRun(db, 'r-1', 's-1');
    const base = await startApi(db);

    expect((await sendChat(base, { sessionId: 's-2', prompt: 'hi' })).status).toBe(503);
  });

  it('checks the prompt before the session', async () => {
    const db = openDb();
    seedSession(db, 's-1');
    registerRun(db, 'r-1', 's-1');
    const base = await startApi(db);

    const res = await sendChat(base, { sessionId: 's-1', prompt: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('prompt_required');
  });
});
