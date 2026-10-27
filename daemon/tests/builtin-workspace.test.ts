import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { registerConfigRoutes } from '../src/routes/config';
import { registerWorkspaceRoutes } from '../src/routes/workspaces';

const dbs: Db[] = [];
const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(): Db {
  const db = new Db(':memory:');
  dbs.push(db);
  return db;
}

function tmpDir(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-builtin-'));
  tmpDirs.push(root);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed `dir` as the built-in fallback (the daemon matches on the path). */
function seedBuiltin(db: Db, dir: string) {
  const ws = db.seedDefaultWorkspace(dir, 'ask', 'flag', dir);
  if (!ws) throw new Error('expected the built-in workspace to be seeded');
  return ws;
}

async function startApi(db: Db): Promise<string> {
  const ctx = {
    db,
    permissions: { clearSession: () => {} },
    config: { permissionMode: 'ask', host: '0.0.0.0', port: 4780, dataDir: '/tmp/paboot', tls: null },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function addWorkspace(base: string, dir: string): Promise<{ id: string; isDefault: boolean }> {
  const res = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { workspace: { id: string; isDefault: boolean } };
  return body.workspace;
}

async function listVisible(base: string): Promise<string[]> {
  const body = (await (await fetch(`${base}/api/workspaces`)).json()) as { workspaces: { id: string }[] };
  return body.workspaces.map((w) => w.id);
}

describe('built-in workspace', () => {
  it('is the default and the only visible workspace on a fresh install', () => {
    const db = openDb();
    const ws = seedBuiltin(db, tmpDir('defaultworkspace'));

    expect(ws.is_builtin).toBe(1);
    expect(db.getDefaultWorkspace()?.id).toBe(ws.id);
    expect(db.listVisibleWorkspaces().map((w) => w.id)).toEqual([ws.id]);
  });

  it('hides and yields the default once a real workspace is added', async () => {
    const db = openDb();
    const builtin = seedBuiltin(db, tmpDir('defaultworkspace'));
    const base = await startApi(db);
    const initial = (await (await fetch(`${base}/api/workspaces`)).json()) as {
      workspaces: { id: string; isBuiltin: boolean }[];
    };
    expect(initial.workspaces.map((w) => ({ id: w.id, isBuiltin: w.isBuiltin }))).toEqual([
      { id: builtin.id, isBuiltin: true },
    ]);
    const created = await addWorkspace(base, tmpDir('project'));

    expect(created.isDefault).toBe(true);
    expect(db.getDefaultWorkspace()?.id).toBe(created.id);
    expect(db.getWorkspace(builtin.id)?.is_default).toBe(0);
    expect(await listVisible(base)).toEqual([created.id]);

    const config = (await (await fetch(`${base}/api/config`)).json()) as {
      defaultWorkspaceId: string;
      workspaces: { id: string }[];
    };
    expect(config.defaultWorkspaceId).toBe(created.id);
    expect(config.workspaces.map((w) => w.id)).toEqual([created.id]);
  });

  it('does not steal the default back when the daemon restarts with the built-in path', () => {
    const db = openDb();
    const dir = tmpDir('defaultworkspace');
    seedBuiltin(db, dir);
    const real = db.createWorkspace({ name: 'project', path: tmpDir('project'), isDefault: true });

    seedBuiltin(db, dir);

    expect(db.getDefaultWorkspace()?.id).toBe(real.id);
    expect(db.listVisibleWorkspaces().map((w) => w.id)).toEqual([real.id]);
  });

  it('returns as the visible default after the last real workspace is deleted', async () => {
    const db = openDb();
    const builtin = seedBuiltin(db, tmpDir('defaultworkspace'));
    const base = await startApi(db);
    const created = await addWorkspace(base, tmpDir('project'));

    const res = await fetch(`${base}/api/workspaces/${created.id}?cascade=0`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(db.getDefaultWorkspace()?.id).toBe(builtin.id);
    expect(await listVisible(base)).toEqual([builtin.id]);
  });

  it('cannot be deleted or disabled', async () => {
    const db = openDb();
    const builtin = seedBuiltin(db, tmpDir('defaultworkspace'));
    const base = await startApi(db);

    const deleted = await fetch(`${base}/api/workspaces/${builtin.id}?cascade=1`, { method: 'DELETE' });
    expect(deleted.status).toBe(409);
    expect(((await deleted.json()) as { code: string }).code).toBe('workspace_is_builtin');

    const disabled = await fetch(`${base}/api/workspaces/${builtin.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(409);
    expect(((await disabled.json()) as { code: string }).code).toBe('workspace_is_builtin');
  });
});
