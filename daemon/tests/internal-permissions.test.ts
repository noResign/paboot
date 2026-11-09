import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { PermissionManager } from '../src/permissions/permissions';
import { RunNotifier } from '../src/runs/run-notifier';
import { registerPermissionRoutes } from '../src/routes/permissions';

const servers: Server[] = [];
const dbs: Db[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harness(permissionMode: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'paboot-internal-permissions-'));
  dirs.push(dir);
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.seedDefaultWorkspace(dir, 'ask')!;
  db.createSession({
    id: 'session-1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: dir,
  });
  db.createRun({
    id: 'run-1',
    sessionId: 'session-1',
    runtime: 'claude',
    model: null,
    prompt: 'hello',
    status: 'running',
    permissionMode,
  });
  const permissions = new PermissionManager(60_000);
  const notifier = new RunNotifier();
  const events: string[] = [];
  notifier.register('run-1', (event) => events.push(event.type));
  const ctx = { db, permissions, notifier } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerPermissionRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const create = (body: unknown) =>
    fetch(`${base}/api/internal/permissions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { db, permissions, events, create, base };
}

describe('internal permission create', () => {
  it('rejects an unknown run instead of parking an invisible request', async () => {
    const h = await harness('ask');
    const response = await h.create({ runId: 'missing', toolName: 'mcp__paboot_capability__echo' });
    expect(response.status).toBe(404);
    expect(h.permissions.get('missing')).toBeUndefined();
  });

  it('asks under ask and announces the request to the run stream', async () => {
    const h = await harness('ask');
    const response = await h.create({ runId: 'run-1', toolName: 'mcp__paboot_capability__echo' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.status).toBe('pending');
    expect(h.permissions.get(body.id)?.sessionId).toBe('session-1');
    expect(h.events).toEqual(['permission_request']);
  });

  it('auto-allows under bypass without announcing', async () => {
    const h = await harness('bypass');
    const response = await h.create({ runId: 'run-1', toolName: 'mcp__paboot_capability__echo' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.status).toBe('allowed');
    expect(h.permissions.get(body.id)?.decisionReason).toBe('bypass');
    expect(h.events).toEqual([]);
  });

  it('auto-allows a tool covered by a saved grant', async () => {
    const h = await harness('ask');
    h.db.addPermissionGrant('session-1', 'mcp__paboot_capability__echo');
    const response = await h.create({ runId: 'run-1', toolName: 'mcp__paboot_capability__echo' });
    const body = (await response.json()) as { id: string; status: string };
    expect(body.status).toBe('allowed');
    expect(h.events).toEqual([]);
  });

  it('reports the current status for a pending request', async () => {
    const h = await harness('ask');
    const response = await h.create({ runId: 'run-1', toolName: 'mcp__paboot_capability__echo' });
    const { id } = (await response.json()) as { id: string };
    const status = await fetch(`${h.base}/api/internal/permissions/${id}/status`);
    expect(await status.json()).toMatchObject({ status: 'pending' });
  });
});
