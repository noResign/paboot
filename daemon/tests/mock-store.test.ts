import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { MockStore } from '../src/capabilities/mock-store';
import { Db } from '../src/db/db';
import { registerMockRoutes } from '../src/routes/mock';

const dbs: Db[] = [];
const dirs: string[] = [];
const stores: MockStore[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.closeAll();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-mock-${name}-`));
  dirs.push(dir);
  return dir;
}

function openStore(): { store: MockStore; dataDir: string } {
  const dataDir = tmpDir('data');
  const store = new MockStore(dataDir);
  stores.push(store);
  return { store, dataDir };
}

describe('mock store', () => {
  it('round-trips api files and rules', () => {
    const { store, dataDir } = openStore();
    const model = store.save('ws-1', {
      apis: [
        { id: 'user.list', method: 'GET', path: '/users', baseline: { status: 200 } },
        { id: 'user.get', method: 'GET', path: '/users/1' },
      ],
      rules: 'user.list: empty\n',
    });
    expect(model.apis.map((api) => api.id)).toEqual(['user.get', 'user.list']);
    expect(model.rules).toBe('user.list: empty\n');
    expect(
      fs.existsSync(path.join(dataDir, 'workspaces', 'ws-1', 'mock', 'apis', 'user.list.json')),
    ).toBe(true);
  });

  it('rejects ids that could escape the workspace directory', () => {
    const { store } = openStore();
    expect(() =>
      store.save('ws-1', { apis: [{ id: '../escape' }], rules: '' }),
    ).toThrow(/invalid mock api id/);
  });
});

describe('mock routes', () => {
  async function boot(family: 'dev' | 'life') {
    const db = new Db(':memory:');
    dbs.push(db);
    const { store, dataDir } = openStore();
    const workspace = db.createWorkspace({ name: family, path: tmpDir(family), family });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      (res.locals as { authRole?: string }).authRole = 'operator';
      next();
    });
    registerMockRoutes(app, { db, mockStore: store } as unknown as AppContext);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workspace,
      dataDir,
    };
  }

  it('gets and saves the model through the HTTP API', async () => {
    const { url, workspace } = await boot('dev');
    const save = await fetch(`${url}/api/workspaces/${workspace.id}/mock`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apis: [{ id: 'user.list', method: 'GET', path: '/users' }],
        rules: '',
      }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { model: { apis: { id: string }[] } };
    expect(saved.model.apis).toHaveLength(1);

    const list = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/mock`)
    ).json()) as { model: { apis: { id: string }[] } };
    expect(list.model.apis[0]?.id).toBe('user.list');
  });

  it('keeps mock dev-only', async () => {
    const { url, workspace } = await boot('life');
    const response = await fetch(`${url}/api/workspaces/${workspace.id}/mock`);
    expect(response.status).toBe(403);
  });
});
