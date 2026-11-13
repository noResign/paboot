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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-life-'));
  tmpDirs.push(root);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed the built-in life workspace and make it the first-run default. */
function seedLife(db: Db) {
  const life = db.ensureLifeWorkspace(tmpDir('life')).workspace;
  db.finalizeWorkspaceDefaults('ask');
  return life;
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

describe('built-in life workspace', () => {
  it('is the default and only workspace on a fresh install', () => {
    const db = openDb();
    const life = seedLife(db);

    expect(life.is_builtin).toBe(1);
    expect(life.family).toBe('life');
    expect(db.getDefaultWorkspace()?.id).toBe(life.id);
    expect(db.listVisibleWorkspaces().map((w) => w.id)).toEqual([life.id]);
  });

  it('yields the default to the first dev workspace but stays visible and switchable', async () => {
    const db = openDb();
    const life = seedLife(db);
    const base = await startApi(db);
    const created = await addWorkspace(base, tmpDir('project'));

    expect(created.isDefault).toBe(true);
    expect(db.getDefaultWorkspace()?.id).toBe(created.id);
    expect(db.getWorkspace(life.id)?.is_default).toBe(0);
    expect(await listVisible(base)).toEqual(expect.arrayContaining([created.id, life.id]));

    const patchLife = await fetch(`${base}/api/workspaces/${life.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    expect(patchLife.status).toBe(200);
    expect(db.getDefaultWorkspace()?.id).toBe(life.id);

    const config = (await (await fetch(`${base}/api/config`)).json()) as {
      defaultWorkspaceId: string;
    };
    expect(config.defaultWorkspaceId).toBe(life.id);
  });

  it('returns as the visible default after the last dev workspace is deleted', async () => {
    const db = openDb();
    const life = seedLife(db);
    const base = await startApi(db);
    const created = await addWorkspace(base, tmpDir('project'));

    const res = await fetch(`${base}/api/workspaces/${created.id}?cascade=0`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(db.getDefaultWorkspace()?.id).toBe(life.id);
    expect(await listVisible(base)).toEqual([life.id]);
  });

  it('cannot be deleted or disabled, but can be renamed', async () => {
    const db = openDb();
    const life = seedLife(db);
    const base = await startApi(db);

    const deleted = await fetch(`${base}/api/workspaces/${life.id}?cascade=1`, { method: 'DELETE' });
    expect(deleted.status).toBe(409);
    expect(((await deleted.json()) as { code: string }).code).toBe('workspace_is_life');

    const disabled = await fetch(`${base}/api/workspaces/${life.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(409);
    expect(((await disabled.json()) as { code: string }).code).toBe('workspace_is_life');

    const renamed = await fetch(`${base}/api/workspaces/${life.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '个人空间' }),
    });
    expect(renamed.status).toBe(200);
  });

  it('removes a legacy empty dev fallback and demotes one that still has sessions', () => {
    const db = openDb();
    const legacyEmpty = db.createWorkspace({
      name: 'defaultworkspace',
      path: tmpDir('defaultworkspace-empty'),
      isBuiltin: true,
    });
    const legacyWithSession = db.createWorkspace({
      name: 'defaultworkspace',
      path: tmpDir('defaultworkspace-session'),
      isBuiltin: true,
    });
    db.createSession({
      id: 's-legacy',
      runtime: 'claude',
      workspaceId: legacyWithSession.id,
      permissionMode: 'ask',
      cwd: legacyWithSession.path,
    });

    db.migrateLegacyBuiltinFallback();

    expect(db.getWorkspace(legacyEmpty.id)).toBeUndefined();
    expect(db.getWorkspace(legacyWithSession.id)?.is_builtin).toBe(0);
    expect(db.listSessions(legacyWithSession.id)).toHaveLength(1);
  });
});
