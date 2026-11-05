import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { PermissionManager } from '../src/permissions/permissions';
import { registerChatRoutes } from '../src/routes/chat';
import { registerWorkspaceRoutes } from '../src/routes/workspaces';
import { RunNotifier } from '../src/runs/run-notifier';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { defaultCapabilities } from '../src/runtimes/types';

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
  starts: RuntimeDriverRequest[];
  workspaceId: string;
  base: string;
}

async function startApi(): Promise<Harness> {
  const workspacePath = tempDir('paboot-default-ws-');
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({
    name: 'demo',
    path: workspacePath,
    defaultRuntime: 'codex',
    defaultPermissionMode: 'acceptEdits',
  });

  const starts: RuntimeDriverRequest[] = [];
  const makeDriver = (id: string): RuntimeDriver => ({
    id,
    start(req) {
      starts.push(req);
      return {
        id: req.runId,
        promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
        cancel: () => {},
      };
    },
  });
  const drivers: Record<string, RuntimeDriver> = {
    claude: makeDriver('claude'),
    codex: makeDriver('codex'),
  };
  const detection = (id: string) => ({
    id,
    name: id,
    bin: id,
    available: true,
    version: 'test',
    authed: true,
    capabilities: { ...defaultCapabilities },
    models: [],
    error: null,
  });
  const registry = {
    driver: (id: string) => drivers[id],
    detection,
    detect: async (id: string) => detection(id),
    list: () => [{ id: 'claude' }, { id: 'codex' }],
  };

  const ctx = {
    db,
    registry,
    permissions: new PermissionManager(1000, () => {}),
    notifier: new RunNotifier(),
    config: {
      permissionMode: 'ask',
      host: '127.0.0.1',
      port: 1,
      runIdleTimeoutMs: 0,
    },
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerChatRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    db,
    starts,
    workspaceId: workspace.id,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function chat(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('workspace new-session defaults', () => {
  it('inherits the workspace runtime and permission mode', async () => {
    const h = await startApi();
    const response = await chat(h.base, { prompt: 'hi' });
    expect(response.status).toBe(200);
    await response.text();

    const [session] = h.db.listSessions();
    expect(session?.runtime).toBe('codex');
    expect(session?.permission_mode).toBe('acceptEdits');
    expect(h.starts[0]?.permissionMode).toBe('acceptEdits');
  });

  it('lets an explicit request override the workspace defaults', async () => {
    const h = await startApi();
    await (await chat(h.base, { prompt: 'hi', runtime: 'claude', permissionMode: 'ask' })).text();

    const [session] = h.db.listSessions();
    expect(session?.runtime).toBe('claude');
    expect(session?.permission_mode).toBe('ask');
  });

  it('keeps an existing session on its own runtime and mode', async () => {
    const h = await startApi();
    const created = h.db.createSession({
      id: 'session-existing',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: tempDir('paboot-default-cwd-'),
    });

    await (await chat(h.base, { prompt: 'again', sessionId: created.id })).text();

    const session = h.db.getSession(created.id)!;
    expect(session.runtime).toBe('claude');
    expect(session.permission_mode).toBe('ask');
  });

  it('validates and clears defaults through PATCH /api/workspaces/:id', async () => {
    const h = await startApi();

    const updated = await fetch(`${h.base}/api/workspaces/${h.workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRuntime: 'claude', defaultPermissionMode: 'bypass' }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { workspace: Record<string, unknown> }).workspace).toMatchObject({
      defaultRuntime: 'claude',
      defaultPermissionMode: 'bypass',
    });

    const badRuntime = await fetch(`${h.base}/api/workspaces/${h.workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRuntime: 'nope' }),
    });
    expect(badRuntime.status).toBe(400);

    const badMode = await fetch(`${h.base}/api/workspaces/${h.workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPermissionMode: 'sometimes' }),
    });
    expect(badMode.status).toBe(400);

    const cleared = await fetch(`${h.base}/api/workspaces/${h.workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRuntime: null, defaultPermissionMode: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { workspace: Record<string, unknown> }).workspace).toMatchObject({
      defaultRuntime: null,
      defaultPermissionMode: null,
    });
  });
});
