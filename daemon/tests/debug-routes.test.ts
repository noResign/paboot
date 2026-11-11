import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { DebugRecorder } from '../src/debug/recorder';
import { Db } from '../src/db/db';
import { requireAuth, requireRolePolicy } from '../src/http/auth';
import { resetDebugFlag } from '../src/platform/debug-flag';
import { registerDebugRoutes } from '../src/routes/debug';

const OPERATOR = 'operator-token-for-debug';
const AGENT = 'agent-token-for-debug';
const SERVER = 'server-token-for-debug';

const dbs: Db[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetDebugFlag();
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  dirs.push(dir);
  return dir;
}

async function setup(): Promise<{ base: string; ctx: AppContext; recorder: DebugRecorder; snapshotId: number }> {
  const db = new Db(':memory:');
  dbs.push(db);
  const { workspace } = db.ensureLifeWorkspace(tmpDir('life'));
  const session = db.createSession({
    id: 's-debug',
    runtime: 'builtin',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
    title: 'debug session',
  });
  const recorder = new DebugRecorder({ mode: 'on', maxBytes: 1024 * 1024, secrets: [OPERATOR] });
  recorder.startRun({
    runId: 'r-debug',
    sessionId: session.id,
    workspaceId: workspace.id,
    runtime: 'builtin',
    model: 'fake:fake-1',
  });
  recorder.recordRunInjection({
    sessionId: session.id,
    workspaceId: workspace.id,
    runId: 'r-debug',
    runtime: 'builtin',
    sessionKind: 'chat',
    purpose: null,
    memoryMode: 'normal',
    model: 'fake:fake-1',
    modelParameters: null,
    permissionMode: 'ask',
    extraDirs: [],
    toolServers: [],
    resumeNativeSession: false,
    knowledge: null,
    memory: null,
    recall: null,
    merged: null,
    injectionMode: 'none',
    prompt: 'hello',
    promptSent: 'hello',
    systemContext: null,
  });
  const snapshot = recorder.recordBuiltinStep({
    sessionId: session.id,
    workspaceId: workspace.id,
    runId: 'r-debug',
    step: 1,
    provider: 'fake',
    model: 'fake-1',
    request: {
      provider: 'fake',
      model: 'fake-1',
      system: `system ${OPERATOR}`,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 10,
      signal: new AbortController().signal,
    },
    assembly: {
      agentId: 'builtin',
      presetId: 'p',
      presetVersion: 1,
      contextVersion: 'ctx',
      system: { stableText: '', dynamicText: '', text: '', sections: [], omitted: [], overBudget: false, version: 'sv' },
      runtimeContext: { text: '', contributions: [], omitted: [], overBudget: false, version: 'rv' },
    } as never,
    estimatedTokens: 3,
  });

  recorder.recordMemoryExtraction({
    batchKey: 'batch-1',
    attempt: 1,
    maxAttempts: 2,
    provider: 'fake',
    model: 'fake-1',
    workspaceId: workspace.id,
    scope: 'user',
    sessionId: session.id,
    runId: 'r-debug',
    sourceIds: ['src-1'],
    request: {
      provider: 'fake',
      model: 'fake-1',
      system: 'extract',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    },
    completion: { text: '{}', toolCalls: [], finishReason: 'stop', usage: null },
    error: null,
    durationMs: 5,
    deterministic: false,
    willRetry: false,
    failureState: null,
  });

  const ctx = {
    db,
    debug: recorder,
    config: {
      debugMaxBytes: 1024 * 1024,
      debugMaxTotalBytes: 32 * 1024 * 1024,
      debugKeepMinutes: 10,
    },
  } as unknown as AppContext;

  const app = express();
  app.use('/api', requireAuth(OPERATOR, { agentToken: AGENT, serverToken: SERVER, maxFailures: 0 }));
  app.use('/api', requireRolePolicy());
  registerDebugRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, ctx, recorder, snapshotId: snapshot! };
}

async function get(base: string, pathName: string, token?: string): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe('debug routes', () => {
  it('serves the page shell without data or the token', async () => {
    const { base } = await setup();
    const res = await get(base, '/debug');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('paboot debug');
    expect(html).not.toContain(OPERATOR);
  });

  it('requires the operator token', async () => {
    const { base } = await setup();
    expect((await get(base, '/api/debug/live')).status).toBe(401);
    expect((await get(base, '/api/debug/live', AGENT)).status).toBe(403);
    const ok = await get(base, '/api/debug/live', OPERATOR);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      runs: Array<{ runId: string; sessionTitle: string }>;
      memory: Array<{ sessionId: string; count: number; sessionTitle: string }>;
    };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ runId: 'r-debug', sessionTitle: 'debug session' });
    expect(body.memory).toEqual([
      expect.objectContaining({ sessionId: 's-debug', count: 1, sessionTitle: 'debug session' }),
    ]);
  });

  it('lists run snapshots without payloads and serves one payload on demand', async () => {
    const { base, snapshotId } = await setup();
    const runRes = await get(base, '/api/debug/runs/r-debug', OPERATOR);
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as {
      injection: { id: number } | null;
      steps: Array<{ id: number }>;
    };
    expect(run.injection).not.toBeNull();
    expect(run.steps).toHaveLength(1);
    expect(JSON.stringify(run)).not.toContain('"payload"');

    const snapRes = await get(base, `/api/debug/snapshots/${snapshotId}`, OPERATOR);
    expect(snapRes.status).toBe(200);
    const snapshot = (await snapRes.json()) as { payload: { system: string } };
    expect(snapshot.payload.system).toContain('[redacted]');
    expect(JSON.stringify(snapshot)).not.toContain(OPERATOR);
  });

  it('returns 404 for a pruned or unknown snapshot', async () => {
    const { base } = await setup();
    const res = await get(base, '/api/debug/snapshots/99999', OPERATOR);
    expect(res.status).toBe(404);
  });

  it('streams metadata over SSE', async () => {
    const { base } = await setup();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/debug/stream`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 2000)),
    ]);
    ctrl.abort();
    expect('value' in first).toBe(true);
    if ('value' in first && first.value) {
      expect(new TextDecoder().decode(first.value)).toContain('connected');
    }
  });
});
