import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { enabledCapabilityServers, resolveCapabilityScope } from '../src/capabilities/scope';
import { Db } from '../src/db/db';
import { registerMcpCapabilityRoutes } from '../src/routes/mcp-capability';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-capability-${name}-`));
  dirs.push(dir);
  return dir;
}

function openDb(): Db {
  const db = new Db(':memory:');
  dbs.push(db);
  return db;
}

describe('capability bindings and scope', () => {
  it('mounts capability only for an enabled, family-compatible binding', () => {
    const db = openDb();
    const devPath = tmpDir('dev');
    const workspace = db.createWorkspace({ name: 'dev', path: devPath, family: 'dev' });
    const session = db.createSession({
      id: 's-dev',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: devPath,
    });
    expect(enabledCapabilityServers(db, session).size).toBe(0);

    db.upsertCapabilityBinding({
      scopeType: 'workspace',
      scopeId: workspace.id,
      providerId: 'android-device',
    });
    // End-scoped capability still needs an active end even with a workspace binding.
    expect(enabledCapabilityServers(db, session).size).toBe(0);
    const end = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Pixel',
      status: 'active',
    });
    db.addEndRoot(end.id, devPath);
    expect(enabledCapabilityServers(db, session).has('paboot_capability')).toBe(true);

    db.upsertCapabilityBinding({
      scopeType: 'session',
      scopeId: session.id,
      providerId: 'android-device',
      enabled: false,
    });
    expect(enabledCapabilityServers(db, session).size).toBe(0);

    const lifePath = tmpDir('life');
    const life = db.createWorkspace({ name: 'life', path: lifePath, family: 'life' });
    const lifeSession = db.createSession({
      id: 's-life',
      runtime: 'claude',
      workspaceId: life.id,
      permissionMode: 'ask',
      cwd: lifePath,
    });
    db.upsertCapabilityBinding({
      scopeType: 'workspace',
      scopeId: life.id,
      providerId: 'android-device',
    });
    expect(enabledCapabilityServers(db, lifeSession).size).toBe(0);
  });

  it('resolves an end from end_roots when the session has no explicit end', () => {
    const db = openDb();
    const devPath = tmpDir('end-root');
    const workspace = db.createWorkspace({ name: 'dev', path: devPath, family: 'dev' });
    const session = db.createSession({
      id: 's-root',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: devPath,
    });
    const end = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Pixel',
      status: 'active',
    });
    db.addEndRoot(end.id, devPath);
    db.upsertCapabilityBinding({
      scopeType: 'end',
      scopeId: end.id,
      providerId: 'android-device',
    });

    expect(resolveCapabilityScope(db, session).end?.id).toBe(end.id);
    expect(enabledCapabilityServers(db, session).has('paboot_capability')).toBe(true);
  });

  it('injects a mounted end into every workspace session, even outside its roots', () => {
    const db = openDb();
    const devPath = tmpDir('workspace-root');
    const androidPath = path.join(devPath, 'android');
    fs.mkdirSync(androidPath);
    const workspace = db.createWorkspace({ name: 'dev', path: devPath, family: 'dev' });
    const session = db.createSession({
      id: 's-outside',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: devPath,
    });
    const end = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Pixel',
      status: 'active',
    });
    db.addEndRoot(end.id, androidPath);
    db.upsertCapabilityBinding({
      scopeType: 'end',
      scopeId: end.id,
      providerId: 'android-device',
    });

    // cwd (workspace root) is not inside the end root, yet the mount applies.
    expect(resolveCapabilityScope(db, session).end?.id).toBe(end.id);
    expect(enabledCapabilityServers(db, session).has('paboot_capability')).toBe(true);
  });

  it('cleans capability bindings when a session or workspace is deleted', () => {
    const db = openDb();
    const devPath = tmpDir('cleanup');
    const workspace = db.createWorkspace({ name: 'dev', path: devPath, family: 'dev' });
    const session = db.createSession({
      id: 's-cleanup',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: devPath,
    });
    const end = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Pixel',
      status: 'active',
    });
    for (const [scopeType, scopeId] of [
      ['session', session.id],
      ['end', end.id],
      ['workspace', workspace.id],
    ] as const) {
      db.upsertCapabilityBinding({ scopeType, scopeId, providerId: 'android-device' });
    }

    db.deleteSession(session.id);
    expect(db.listCapabilityBindings('session', session.id)).toHaveLength(0);

    db.deleteWorkspace(workspace.id);
    expect(db.listCapabilityBindings('end', end.id)).toHaveLength(0);
    expect(db.listCapabilityBindings('workspace', workspace.id)).toHaveLength(0);
  });

  it('exposes the resolved scope to the capability MCP server by run id', async () => {
    const db = openDb();
    const devPath = tmpDir('scope-route');
    const workspace = db.createWorkspace({ name: 'dev', path: devPath, family: 'dev' });
    const session = db.createSession({
      id: 's-route',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: devPath,
    });
    const end = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Pixel',
      status: 'active',
    });
    db.addEndRoot(end.id, devPath);
    db.createRun({
      id: 'r-route',
      sessionId: session.id,
      runtime: 'claude',
      model: null,
      prompt: 'hello',
      status: 'running',
    });

    const app = express();
    registerMcpCapabilityRoutes(app, { db } as unknown as AppContext);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/internal/mcp/capability/scope?runId=r-route`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: 'r-route',
      sessionId: session.id,
      workspaceId: workspace.id,
      endId: end.id,
      family: 'dev',
    });
  });
});
