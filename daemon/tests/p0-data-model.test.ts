import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-p02-'));
  tmpDirs.push(root);
  return root;
}

function tmpDir(name: string): string {
  const dir = path.join(tmpRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedDev(db: Db) {
  const ws = db.seedDefaultWorkspace(tmpDir('repo'), 'ask');
  if (!ws) throw new Error('expected seedDefaultWorkspace to create a workspace');
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

describe('P0.2 data model', () => {
  it('fills D35 defaults for new workspaces and sessions', () => {
    const db = openDb();
    const ws = seedDev(db);

    expect(ws.family).toBe('dev');
    expect(ws.profile_mode).toBe('portable');
    expect(ws.life_readable).toBe(0);

    db.createSession({
      id: 's-1',
      runtime: 'claude',
      workspaceId: ws.id,
      permissionMode: 'ask',
      cwd: ws.path,
    });
    const session = db.getSession('s-1');
    expect(session?.end_id).toBeNull();
    expect(session?.memory_mode).toBe('normal');
  });

  it('ensures exactly one built-in life workspace and one life end', () => {
    const db = openDb();
    const lifePath = path.join(tmpRoot(), 'life');

    const first = db.ensureLifeWorkspace(lifePath);
    expect(first.workspace.family).toBe('life');
    expect(first.workspace.is_builtin).toBe(1);
    expect(first.workspace.profile_mode).toBe('portable');
    expect(first.workspace.path).toBe(fs.realpathSync(lifePath));
    expect(first.end.family).toBe('life');
    expect(first.end.kind).toBe('life');
    expect(first.end.status).toBe('active');

    const second = db.ensureLifeWorkspace(lifePath);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.end.id).toBe(first.end.id);
    expect(db.listEnds(first.workspace.id)).toHaveLength(1);
  });

  it('rejects ends whose family does not match the workspace', () => {
    const db = openDb();
    const dev = seedDev(db);
    const life = db.ensureLifeWorkspace(path.join(tmpRoot(), 'life'));

    expect(() =>
      db.createEnd({ workspaceId: dev.id, family: 'life', kind: 'life', name: '生活' }),
    ).toThrow(/end family mismatch/);
    expect(() =>
      db.createEnd({ workspaceId: life.workspace.id, family: 'dev', kind: 'android', name: 'app' }),
    ).toThrow(/end family mismatch/);
    // A missing workspace must fail too, not silently create a dangling end.
    expect(() =>
      db.createEnd({ workspaceId: 'missing', family: 'dev', kind: 'android', name: 'ghost' }),
    ).toThrow(/end family mismatch/);

    expect(db.createEnd({ workspaceId: dev.id, family: 'dev', kind: 'android', name: 'app' }).id).toBeTruthy();
  });

  it('allows only one life end per workspace', () => {
    const db = openDb();
    const life = db.ensureLifeWorkspace(path.join(tmpRoot(), 'life'));

    expect(() =>
      db.createEnd({ workspaceId: life.workspace.id, family: 'life', kind: 'life', name: 'second' }),
    ).toThrow();
    expect(db.listEnds(life.workspace.id)).toHaveLength(1);
  });

  it('cleans ends when a dev workspace is deleted', () => {
    const db = openDb();
    const dev = seedDev(db);
    db.createEnd({ workspaceId: dev.id, family: 'dev', kind: 'android', name: 'app' });

    db.deleteWorkspace(dev.id);

    expect(db.getWorkspace(dev.id)).toBeUndefined();
    expect(db.listEnds(dev.id)).toEqual([]);
  });

  it('keeps life visible while hiding only the dev fallback', () => {
    const db = openDb();
    const fallbackDir = tmpDir('fallback');
    const fallback = db.seedDefaultWorkspace(fallbackDir, 'ask', 'flag', fallbackDir);
    if (!fallback) throw new Error('expected the built-in fallback');

    const life = db.ensureLifeWorkspace(path.join(tmpRoot(), 'life'));
    expect(db.listVisibleWorkspaces().map((w) => w.id)).toEqual(
      expect.arrayContaining([fallback.id, life.workspace.id]),
    );

    const real = db.createWorkspace({ name: 'real', path: tmpDir('real') });
    const visible = db.listVisibleWorkspaces().map((w) => w.id);
    expect(visible).toContain(real.id);
    expect(visible).toContain(life.workspace.id);
    expect(visible).not.toContain(fallback.id);
  });

  it('creates the memory settings and outbox tables', () => {
    const file = path.join(tmpRoot(), 'paboot.sqlite');
    const db = new Db(file);
    db.close();

    const raw = new DatabaseSync(file);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as unknown as {
      name: string;
    }[]).map((row) => row.name);
    raw.close();

    expect(tables).toEqual(
      expect.arrayContaining([
        'ends',
        'end_roots',
        'memory_settings',
        'notification_outbox',
        'deletion_outbox',
      ]),
    );
  });

  it('protects the life workspace from default, disable and delete, but allows extra dirs', async () => {
    const db = openDb();
    const life = db.ensureLifeWorkspace(path.join(tmpRoot(), 'life'));
    const base = await startApi(db);

    const list = (await (await fetch(`${base}/api/workspaces`)).json()) as {
      workspaces: {
        id: string;
        family?: string;
        profileMode?: string;
        lifeReadable?: boolean;
      }[];
    };
    const dto = list.workspaces.find((w) => w.id === life.workspace.id);
    expect(dto?.family).toBe('life');
    expect(dto?.profileMode).toBe('portable');
    expect(dto?.lifeReadable).toBe(false);

    const patch = (body: unknown) =>
      fetch(`${base}/api/workspaces/${life.workspace.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await patch({ enabled: false })).status).toBe(409);
    expect((await patch({ isDefault: true })).status).toBe(409);
    expect((await patch({ name: '生活' })).status).toBe(200);

    expect((await fetch(`${base}/api/workspaces/${life.workspace.id}`, { method: 'DELETE' })).status).toBe(409);

    // Extra dirs are allowed for life too: they widen the same access the dev
    // workspaces get; only the workspace lifecycle (delete/disable/default) is restricted.
    const extra = tmpDir('extra');
    const addDir = await fetch(`${base}/api/workspaces/${life.workspace.id}/dirs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: extra }),
    });
    expect(addDir.status).toBe(201);
    expect(((await addDir.json()) as { dirs: string[] }).dirs).toEqual([fs.realpathSync(extra)]);

    const removeDir = await fetch(`${base}/api/workspaces/${life.workspace.id}/dirs`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: extra }),
    });
    expect(removeDir.status).toBe(200);

    const cfg = await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultWorkspaceId: life.workspace.id }),
    });
    expect(cfg.status).toBe(409);
  });
});
