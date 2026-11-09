import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db, type EventRow } from '../src/db/db';
import { DEFAULT_BUILTIN_CONFIG } from '../src/runtimes/builtin/config';
import { captureRunObservation, extractToolFiles } from '../src/memory/observe';
import type { MemoryRunScope } from '../src/memory/scope-resolver';
import { MemoryStore } from '../src/memory/store';
import { PermissionManager } from '../src/permissions/permissions';
import { registerMemoryRoutes } from '../src/routes/memory';
import { startSessionRun, type RunSink } from '../src/runs/run-service';
import { RunNotifier } from '../src/runs/run-notifier';
import type { RuntimeDriver } from '../src/runtimes/RuntimeDriver';

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

function event(seq: number, type: string, payload: unknown): EventRow {
  return { id: seq, run_id: 'run-1', seq, type, payload: JSON.stringify(payload), created_at: Date.now() };
}

function setup() {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace } = db.ensureLifeWorkspace(tmpDir('life'));
  const session = db.createSession({
    id: 's-observe',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  db.addMessage(session.id, 'user', '修复登录页的报错');
  db.addMessage(session.id, 'assistant', '已修复登录页，并更新了 src/login.ts。');
  const scope: MemoryRunScope = {
    scope: `workspace:${workspace.id}`,
    workspaceId: workspace.id,
    endId: null,
    sessionId: session.id,
    runId: 'run-1',
  };
  // A captured source is what links an observation back to L0.
  store.insertSource({
    scope: scope.scope,
    endId: null,
    kind: 'message',
    sourceTable: 'messages',
    sessionId: session.id,
    runId: 'run-1',
    occurredAt: Date.now(),
    content: '修复登录页的报错',
  });
  return { db, store, workspace, session, scope };
}

describe('observation capture', () => {
  it('extracts structured file tools and ignores Bash guesses', () => {
    const files = extractToolFiles([
      event(1, 'tool_use', { type: 'tool_use', name: 'Read', input: { file_path: 'src/login.ts' } }),
      event(2, 'tool_use', { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.ts' } }),
      event(3, 'tool_use', { type: 'tool_use', name: 'Read', input: { file_path: 'package.json' } }),
      event(4, 'tool_use', { type: 'tool_use', name: 'Bash', input: { command: 'cat secrets.txt' } }),
    ]);
    expect(files.filesRead).toEqual(['src/login.ts', 'package.json']);
    expect(files.filesModified).toEqual(['src/login.ts']);
  });

  it('writes one idempotent turn observation and a session summary', () => {
    const { db, store, scope, session } = setup();
    const messages = db.listMessages(session.id);
    const events = [
      event(1, 'tool_use', { type: 'tool_use', name: 'Read', input: { file_path: 'src/login.ts' } }),
      event(2, 'tool_use', { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.ts' } }),
    ];

    const first = captureRunObservation({ store, scope, messages, toolEvents: events });
    expect(first.observation).toMatchObject({
      kind: 'turn',
      type: 'bugfix',
      title: '修复登录页的报错',
      filesRead: ['src/login.ts'],
      filesModified: ['src/login.ts'],
    });
    expect(first.summary?.completed).toContain('已修复登录页');

    const second = captureRunObservation({ store, scope, messages, toolEvents: events });
    expect(second.observation?.id).toBe(first.observation?.id);
    expect(store.listObservations(scope.scope)).toHaveLength(1);
    expect(store.listSessionSummaries(scope.scope)).toHaveLength(1);
  });

  it('captures an observation after a run finishes', async () => {
    const { db, store, workspace, session } = setup();
    const driver: RuntimeDriver = {
      id: 'claude',
      start(req) {
        return {
          id: req.runId,
          promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
          cancel: () => {},
        };
      },
    };
    const ctx = {
      db,
      memory: store,
      builtinConfig: DEFAULT_BUILTIN_CONFIG,
      permissions: new PermissionManager(),
      notifier: new RunNotifier(),
      registry: { detection: () => undefined },
    } as unknown as AppContext;
    const sink: RunSink = { frame: () => {}, end: () => {} };
    const run = startSessionRun(ctx, {
      session,
      workspace,
      prompt: '修复登录页的报错',
      driver,
      permissionMode: 'ask',
      model: null,
      modelParameters: null,
      trigger: 'user',
      sink,
    });
    await run.done;
    await new Promise((resolve) => setImmediate(resolve));
    const observations = store.listObservations(`workspace:${workspace.id}`);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.title).toContain('修复登录页');
    expect(store.listSessionSummaries(`workspace:${workspace.id}`)).toHaveLength(1);
  });

  it('serves observation/summary hits and the timeline with a files filter', async () => {
    const { db, store, scope, session } = setup();
    const messages = db.listMessages(session.id);
    captureRunObservation({
      store,
      scope,
      messages,
      toolEvents: [
        event(1, 'tool_use', { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.ts' } }),
      ],
    });

    const ctx = { db, memory: store } as unknown as AppContext;
    const app = express();
    app.use(express.json());
    registerMemoryRoutes(app, ctx);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const search = await fetch(
      `${url}/api/memory/search?sessionId=${session.id}&q=${encodeURIComponent('登录页')}`,
    );
    const searchBody = (await search.json()) as {
      hits: { kind: string; files?: string[] }[];
    };
    expect(searchBody.hits.map((hit) => hit.kind)).toContain('observation');
    expect(searchBody.hits.map((hit) => hit.kind)).toContain('summary');

    const unmatched = await fetch(
      `${url}/api/memory/search?sessionId=${session.id}&q=${encodeURIComponent('登录页')}&files=nope.ts`,
    );
    expect(((await unmatched.json()) as { hits: unknown[] }).hits).toEqual([]);

    const matched = await fetch(
      `${url}/api/memory/search?sessionId=${session.id}&q=${encodeURIComponent('登录页')}&files=src/login.ts`,
    );
    const matchedBody = (await matched.json()) as { hits: { files?: string[] }[] };
    expect(matchedBody.hits.length).toBeGreaterThan(0);

    const timeline = await fetch(`${url}/api/memory/timeline?sessionId=${session.id}`);
    const timelineBody = (await timeline.json()) as {
      items: { kind: string; title: string; files: string[] }[];
    };
    expect(timelineBody.items.map((item) => item.kind).sort()).toEqual([
      'observation',
      'summary',
    ]);
    expect(timelineBody.items[0]).toMatchObject({ files: expect.any(Array) });
  });
});
