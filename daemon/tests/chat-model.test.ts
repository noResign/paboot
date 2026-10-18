import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context';
import type { NormalizedEvent } from '../src/types/api';
import { Db } from '../src/db';
import { registerChatRoutes } from '../src/routes/chat';
import { registerSessionRoutes } from '../src/routes/sessions';
import { listActiveRuns, registerActiveRun } from '../src/runtimes/active-runs';
import { RunNotifier } from '../src/run-notifier';
import { PermissionManager } from '../src/permissions';

vi.mock('../src/checkpoints', () => ({
  captureCheckpoint: vi.fn(async () => null),
  repoRootFor: vi.fn(async () => null),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const runs = listActiveRuns();
  for (const run of runs) run.cancel();
  await Promise.all(runs.map((run) => run.promise));
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});

interface StartRequest {
  runId: string;
  onEvent(event: NormalizedEvent): void;
  model?: string;
  modelParameters?: Record<string, string>;
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-model-'));
  const db = new Db(':memory:');
  db.seedDefaultWorkspace(dir, 'ask');

  const starts: StartRequest[] = [];
  const start = vi.fn((req: StartRequest) => {
    starts.push(req);
    const run = {
      id: req.runId,
      promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
      cancel: () => {},
    };
    registerActiveRun(run);
    return run;
  });

  const ctx = {
    db,
    registry: {
      driver: () => ({ start }),
      detection: () => ({ available: true }),
      detect: async () => ({ available: true }),
    },
    notifier: new RunNotifier(),
    permissions: new PermissionManager(),
    config: { runIdleTimeoutMs: 0, permissionMode: 'ask' },
    hookPath: '',
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerChatRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return { db, post, starts, base };
}

describe('session model selection', () => {
  it('persists the model chosen for a new session and uses it on later runs', async () => {
    const { db, post, starts } = await setup();

    const first = await post({ prompt: 'first', runtime: 'claude', model: 'opus' });
    await first.text();

    const session = db.listSessions()[0];
    expect(starts[0].model).toBe('opus');
    expect(session.model).toBe('opus');
    expect(db.listRuns(session.id)[0].model).toBe('opus');

    const second = await post({ prompt: 'second', sessionId: session.id });
    await second.text();
    expect(starts[1].model).toBe('opus');
  });

  it('lets a request override the session model without rewriting the session', async () => {
    const { db, post, starts } = await setup();

    await (await post({ prompt: 'first', runtime: 'claude', model: 'opus' })).text();
    const session = db.listSessions()[0];

    await (await post({ prompt: 'second', sessionId: session.id, model: 'sonnet' })).text();

    expect(starts[1].model).toBe('sonnet');
    expect(db.getSession(session.id)?.model).toBe('opus');
    expect(db.listRuns(session.id).at(-1)?.model).toBe('sonnet');
  });

  it('treats the legacy `default` sentinel as "no explicit model"', async () => {
    const { db, post, starts } = await setup();

    await (await post({ prompt: 'first', runtime: 'claude', model: 'default' })).text();

    expect(starts[0].model).toBeUndefined();
    expect(db.listSessions()[0].model).toBeNull();
    expect(db.listRuns(db.listSessions()[0].id)[0].model).toBeNull();
  });

  it('persists model parameters and falls back to them on later runs', async () => {
    const { db, post, starts } = await setup();

    await (await post({
      prompt: 'first',
      runtime: 'claude',
      model: 'opus',
      modelParameters: { reasoningEffort: 'high' },
    })).text();

    const session = db.listSessions()[0];
    expect(session.model_parameters).toBe(JSON.stringify({ reasoningEffort: 'high' }));
    expect(starts[0].modelParameters).toEqual({ reasoningEffort: 'high' });

    await (await post({ prompt: 'second', sessionId: session.id })).text();
    expect(starts[1].modelParameters).toEqual({ reasoningEffort: 'high' });
  });

  it('updates parameters without disturbing the model, and vice versa', async () => {
    const { db, post, base } = await setup();
    await (await post({ prompt: 'first', runtime: 'claude', model: 'sonnet' })).text();
    const session = db.listSessions()[0];
    const patch = (body: Record<string, unknown>) =>
      fetch(`${base}/api/sessions/${session.id}/model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const paramsOnly = await patch({ modelParameters: { reasoningEffort: 'low' } });
    expect(paramsOnly.status).toBe(200);
    expect(await paramsOnly.json()).toMatchObject({
      session: { model: 'sonnet', modelParameters: { reasoningEffort: 'low' } },
    });

    const modelOnly = await patch({ model: 'opus' });
    expect(modelOnly.status).toBe(200);
    expect(await modelOnly.json()).toMatchObject({
      session: { model: 'opus', modelParameters: { reasoningEffort: 'low' } },
    });

    const cleared = await patch({ modelParameters: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      session: { model: 'opus', modelParameters: null },
    });
  });

  it('switches the session model for subsequent runs', async () => {
    const { db, post, starts, base } = await setup();

    await (await post({ prompt: 'first', runtime: 'claude' })).text();
    const session = db.listSessions()[0];
    expect(session.model).toBeNull();

    const res = await fetch(`${base}/api/sessions/${session.id}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      effective: 'next_run',
      session: { model: 'sonnet' },
    });

    await (await post({ prompt: 'second', sessionId: session.id })).text();
    expect(starts[1].model).toBe('sonnet');
  });

  it('clears the session model with null so the CLI default wins again', async () => {
    const { db, post, starts, base } = await setup();

    await (await post({ prompt: 'first', runtime: 'claude', model: 'opus' })).text();
    const session = db.listSessions()[0];

    const res = await fetch(`${base}/api/sessions/${session.id}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });
    expect(res.status).toBe(200);
    expect(db.getSession(session.id)?.model).toBeNull();

    await (await post({ prompt: 'second', sessionId: session.id })).text();
    expect(starts[1].model).toBeUndefined();
  });

  it('rejects an unknown session and a body without a model', async () => {
    const { post, base } = await setup();

    const unknown = await fetch(`${base}/api/sessions/nope/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    });
    expect(unknown.status).toBe(404);

    await (await post({ prompt: 'first', runtime: 'claude' })).text();
    const session = (await (await fetch(`${base}/api/sessions`)).json()).sessions[0];

    const missing = await fetch(`${base}/api/sessions/${session.id}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  });

  it('exposes the session model on the session DTO', async () => {
    const { db, post, base } = await setup();

    await (await post({ prompt: 'first', runtime: 'codex', model: 'gpt-5' })).text();
    const session = db.listSessions()[0];

    const detail = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
    expect(detail.session).toMatchObject({ runtime: 'codex', model: 'gpt-5' });
  });
});
