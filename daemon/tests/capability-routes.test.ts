import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { DeviceStreamHub } from '../src/capabilities/device-stream';
import { parseCapabilityArgs, runCapabilityCli } from '../src/capabilities/cli';
import { enabledCapabilityServers } from '../src/capabilities/scope';
import type { DeviceProvider } from '../src/capabilities/types';
import { Db } from '../src/db/db';
import { registerCapabilityDeviceRoutes } from '../src/routes/capability-device';
import { registerDeviceRoutes } from '../src/routes/device';
import { registerEndRoutes } from '../src/routes/ends';

const dbs: Db[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-cap-routes-${name}-`));
  dirs.push(dir);
  return dir;
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fakeProvider(): DeviceProvider {
  return {
    async list() {
      return [{ serial: 's1', state: 'device', model: 'Pixel' }];
    },
    async resolveSerial(explicit) {
      return explicit ?? 's1';
    },
    async screenshot() {
      return { png: png(10, 20), width: 10, height: 20 };
    },
    async uiDump() {
      return { xml: '', nodes: [] };
    },
    async tap() {},
    async tapSelector() {
      return { x: 1, y: 2 };
    },
    async inputText() {},
    async keyEvent() {},
    async launchApp() {},
    async logcat() {
      return 'log';
    },
    async currentActivity() {
      return 'pkg/.Main';
    },
  };
}

async function boot() {
  const db = new Db(':memory:');
  dbs.push(db);
  const root = tmpDir('dev');
  fs.writeFileSync(path.join(root, 'build.gradle'), 'android {}');
  const workspace = db.createWorkspace({ name: 'dev', path: root, family: 'dev' });
  const session = db.createSession({
    id: 's-dev',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: root,
  });
  db.createRun({
    id: 'r-dev',
    sessionId: session.id,
    runtime: 'claude',
    model: null,
    prompt: 'hello',
    status: 'running',
  });

  let role: 'operator' | 'agent' = 'operator';
  const ctx = {
    db,
    deviceProvider: fakeProvider(),
    config: { host: '127.0.0.1', port: 0, tls: false },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    (res.locals as { authRole?: string }).authRole = role;
    next();
  });
  registerEndRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerCapabilityDeviceRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    workspace,
    session,
    root,
    url: `http://127.0.0.1:${port}`,
    setRole(next: 'operator' | 'agent') {
      role = next;
    },
    ctx,
  };
}

describe('ends routes', () => {
  it('suggests, creates, binds and activates an Android end', async () => {
    const { db, workspace, session, root, url } = await boot();

    const suggestions = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/end-suggestions`)
    ).json()) as { suggestions: { path: string; reasons: string[] }[] };
    expect(suggestions.suggestions).toContainEqual(
      expect.objectContaining({ path: root, reasons: ['Gradle'] }),
    );

    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string; status: string } };
    expect(created.end.status).toBe('draft');

    const bound = await fetch(
      `${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/roots`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: root }),
      },
    );
    expect(bound.status).toBe(200);

    const activated = await fetch(
      `${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/activate`,
      { method: 'POST' },
    );
    expect(activated.status).toBe(200);
    expect(db.getEnd(created.end.id)?.status).toBe('active');
    expect(enabledCapabilityServers(db, session).has('paboot_capability')).toBe(true);
  });

  it('binds several roots, removes a root and deletes the end', async () => {
    const { db, workspace, session, root, url } = await boot();
    const androidDir = path.join(root, 'android');
    fs.mkdirSync(androidDir);
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    const endId = created.end.id;
    for (const dir of [root, androidDir]) {
      const bound = await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(bound.status).toBe(200);
    }
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/activate`, { method: 'POST' });
    expect(db.listEndRoots(endId)).toHaveLength(2);
    expect(enabledCapabilityServers(db, session).has('paboot_capability')).toBe(true);

    const removed = await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/roots`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: androidDir }),
    });
    expect(removed.status).toBe(200);
    expect(db.listEndRoots(endId)).toEqual([root]);

    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/archive`, { method: 'POST' });
    const deleted = await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(db.getEnd(endId)).toBeUndefined();
    expect(db.getSession(session.id)?.end_id).toBeNull();
    expect(enabledCapabilityServers(db, session).has('paboot_capability')).toBe(false);
  });

  it('rejects roots outside the workspace', async () => {
    const { workspace, url } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    const outside = await fetch(
      `${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/roots`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: tmpDir('outside') }),
      },
    );
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { code: string }).code).toBe('root_outside');
  });

  it('previews impact, then archives and restores an end', async () => {
    const { db, workspace, session, root, url } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    const endId = created.end.id;
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/activate`, { method: 'POST' });

    const impact = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/impact`)
    ).json()) as { impact: Record<string, unknown> };
    expect(impact.impact).toMatchObject({
      explicitSessions: 0,
      cwdSessions: 1,
      capabilityBindings: 1,
      roots: 1,
      capabilities: ['Android 设备'],
    });

    const archived = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/archive`, { method: 'POST' })
    ).json()) as { end: { status: string; archivedAt: number | null } };
    expect(archived.end.status).toBe('archived');
    expect(archived.end.archivedAt).toBeTypeOf('number');
    expect(enabledCapabilityServers(db, db.getSession(session.id)!).has('paboot_capability')).toBe(
      false,
    );

    const restored = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/restore`, { method: 'POST' })
    ).json()) as { end: { status: string; archivedAt: number | null } };
    expect(restored.end.status).toBe('active');
    expect(restored.end.archivedAt).toBeNull();
    expect(enabledCapabilityServers(db, db.getSession(session.id)!).has('paboot_capability')).toBe(
      true,
    );
  });

  it('requires archiving before an end can be deleted', async () => {
    const { db, workspace, root, url } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    const endId = created.end.id;
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/activate`, { method: 'POST' });

    const refused = await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}`, {
      method: 'DELETE',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('end_must_archive');

    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/archive`, { method: 'POST' });
    const deleted = await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(db.getEnd(endId)).toBeUndefined();
    expect(db.listEndRoots(endId)).toHaveLength(0);
    expect(db.listCapabilityBindings('end', endId)).toHaveLength(0);
  });
});

describe('operator device routes', () => {
  it('lists devices, selects a serial and dispatches actions', async () => {
    const { workspace, root, url } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/activate`, {
      method: 'POST',
    });

    const list = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/device`)
    ).json()) as { endId: string; serial: string | null; devices: unknown[] };
    expect(list).toMatchObject({ endId: created.end.id, serial: 's1' });
    expect(list.devices).toHaveLength(1);

    const selected = await fetch(`${url}/api/workspaces/${workspace.id}/device/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endId: created.end.id, serial: 's1' }),
    });
    expect(selected.status).toBe(200);

    const tap = await fetch(`${url}/api/workspaces/${workspace.id}/device/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endId: created.end.id, action: 'tap', x: 5, y: 6 }),
    });
    expect(tap.status).toBe(200);
    expect(await tap.json()).toMatchObject({ ok: true, x: 5, y: 6 });

    const shot = await fetch(`${url}/api/workspaces/${workspace.id}/device/screenshot`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await shot.arrayBuffer()).byteLength).toBe(24);
  });

  it('rejects agent tokens even for screenshots', async () => {
    const { workspace, root, url, setRole } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/activate`, {
      method: 'POST',
    });
    setRole('agent');
    const shot = await fetch(`${url}/api/workspaces/${workspace.id}/device/screenshot`);
    expect(shot.status).toBe(403);
  });

  it('rejects an explicit archived end id', async () => {
    const { workspace, root, url } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    const endId = created.end.id;
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/activate`, { method: 'POST' });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${endId}/archive`, { method: 'POST' });

    const listed = await fetch(
      `${url}/api/workspaces/${workspace.id}/device?endId=${encodeURIComponent(endId)}`,
    );
    expect(listed.status).toBe(409);
    expect(((await listed.json()) as { code: string }).code).toBe('end_archived');

    const action = await fetch(`${url}/api/workspaces/${workspace.id}/device/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endId, action: 'tap', x: 1, y: 2 }),
    });
    expect(action.status).toBe(409);
    expect(((await action.json()) as { code: string }).code).toBe('end_archived');
  });
});

describe('device stream hub', () => {
  it('streams frames and stops after the last subscriber leaves', async () => {
    const writes: string[] = [];
    const res = {
      writableEnded: false,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      on: () => {},
    } as unknown as ServerResponse;
    const hub = new DeviceStreamHub(fakeProvider(), 10);
    const unsubscribe = hub.subscribe('e1', 's1', res);
    await new Promise((resolve) => setTimeout(resolve, 35));
    unsubscribe();
    hub.closeAll();
    expect(writes.join('')).toContain('"type":"frame"');
    expect(writes.join('')).toContain('"width":10');
  });
});

describe('capability CLI', () => {
  it('parses device actions and selector flags', () => {
    expect(
      parseCapabilityArgs([
        'android',
        'tap',
        '--workspace',
        'w1',
        '--x',
        '10',
        '--y',
        '20',
        '--serial',
        's1',
      ]),
    ).toMatchObject({
      action: 'tap',
      workspace: 'w1',
      serial: 's1',
      params: { x: 10, y: 20 },
    });
    expect(
      parseCapabilityArgs([
        'android',
        'tap-selector',
        '--workspace',
        'w1',
        '--selector-text',
        '登录',
      ]).params,
    ).toEqual({ selector: { text: '登录' } });
    expect(() => parseCapabilityArgs(['android', 'nope', '--workspace', 'w'])).toThrow(
      /unknown android action/,
    );
  });

  it('writes screenshot bytes to a file through the operator action route', async () => {
    const { workspace, root, url } = await boot();
    const created = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pixel' }),
      })
    ).json()) as { end: { id: string } };
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${created.end.id}/activate`, {
      method: 'POST',
    });

    const out = path.join(root, 'shot.png');
    const code = await runCapabilityCli(
      [
        'android',
        'screenshot',
        '--workspace',
        workspace.id,
        '--end',
        created.end.id,
        '--serial',
        's1',
        '--out',
        out,
      ],
      { PABOOT_DAEMON_URL: url, PABOOT_TOKEN: 'operator' },
      { write: () => true } as unknown as NodeJS.WritableStream,
    );
    expect(code).toBe(0);
    expect(fs.readFileSync(out).byteLength).toBe(24);
  });
});
