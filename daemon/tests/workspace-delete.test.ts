import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { registerWorkspaceRoutes } from '../src/routes/workspaces';

const dbs: Db[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const db of dbs.splice(0)) db.close();
});

function openDb(): Db {
  const db = new Db(':memory:');
  dbs.push(db);
  return db;
}

/** Serve the workspace routes with a stub permission manager (nothing else is touched). */
async function startApi(db: Db): Promise<string> {
  const ctx = { db, permissions: { clearSession: () => {} } } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Seeded {
  workspaceId: string;
  sessionId: string;
  runId: string;
}

/**
 * A **non-default** workspace holding one session with a run, an event, a
 * message and a grant. The startup workspace stays default, since the default
 * one can never be deleted.
 */
function seedWorkspaceWithSession(db: Db): Seeded {
  const startup = db.seedDefaultWorkspace(process.cwd(), 'ask');
  if (!startup) throw new Error('expected a seeded workspace');
  const workspace = db.createWorkspace({ name: 'target', path: '/srv/target' });
  db.createSession({ id: 's-1', runtime: 'claude', workspaceId: workspace.id, permissionMode: 'ask', cwd: workspace.path });
  db.createRun({ id: 'r-1', sessionId: 's-1', runtime: 'claude', model: null, prompt: 'hi', status: 'running' });
  db.appendEvent('r-1', 1, 'text_delta', { type: 'text_delta', delta: 'hi' });
  db.addMessage('s-1', 'user', 'hi');
  db.addPermissionGrant('s-1', 'Bash');
  db.addWorkspaceDir(workspace.id, '/srv/granted');
  db.addWorkspaceShortcut(workspace.id, '/srv/bookmark');
  return { workspaceId: workspace.id, sessionId: 's-1', runId: 'r-1' };
}

async function deleteWorkspace(base: string, id: string, cascade: boolean) {
  const response = await fetch(`${base}/api/workspaces/${id}?cascade=${cascade ? '1' : '0'}`, { method: 'DELETE' });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('DELETE /api/workspaces/:id', () => {
  it('refuses a non-empty workspace without cascade', async () => {
    const db = openDb();
    const seeded = seedWorkspaceWithSession(db);
    const base = await startApi(db);

    const res = await deleteWorkspace(base, seeded.workspaceId, false);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_not_empty');
    expect(res.body.sessionCount).toBe(1);
    // 什么都没动。
    expect(db.getWorkspace(seeded.workspaceId)).toBeTruthy();
    expect(db.listSessions(seeded.workspaceId)).toHaveLength(1);
    expect(db.listEvents(seeded.runId)).toHaveLength(1);
  });

  it('cascade deletes the workspace and everything under it', async () => {
    const db = openDb();
    const seeded = seedWorkspaceWithSession(db);
    const base = await startApi(db);

    const res = await deleteWorkspace(base, seeded.workspaceId, true);

    expect(res.status).toBe(200);
    expect(res.body.deletedSessions).toBe(1);
    expect(db.getWorkspace(seeded.workspaceId)).toBeUndefined();
    expect(db.listSessions(seeded.workspaceId)).toEqual([]);
    expect(db.getRun(seeded.runId)).toBeUndefined();
    expect(db.listEvents(seeded.runId)).toEqual([]);
    expect(db.listMessages(seeded.sessionId)).toEqual([]);
    expect(db.hasPermissionGrant(seeded.sessionId, 'Bash')).toBe(false);
    expect(db.listWorkspaceDirs(seeded.workspaceId)).toEqual([]);
    expect(db.listWorkspaceShortcuts(seeded.workspaceId)).toEqual([]);
  });

  // 默认工作区是客户端没指定工作区时的落点，删了新会话就没地方去；这条同时保证
  // 「最后一个工作区」永远删不掉（它必然是默认的那个）。
  it('refuses to delete the default workspace, even with cascade', async () => {
    const db = openDb();
    seedWorkspaceWithSession(db);
    const startup = db.getDefaultWorkspace();
    if (!startup) throw new Error('expected a default workspace');
    db.createSession({ id: 's-2', runtime: 'claude', workspaceId: startup.id, permissionMode: 'ask', cwd: startup.path });
    const base = await startApi(db);

    const res = await deleteWorkspace(base, startup.id, true);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_is_default');
    expect(db.getWorkspace(startup.id)).toBeTruthy();
    expect(db.listSessions(startup.id)).toHaveLength(1);
  });

  it('deletes a non-empty non-default workspace with cascade only', async () => {
    const db = openDb();
    const seeded = seedWorkspaceWithSession(db);
    const base = await startApi(db);

    expect((await deleteWorkspace(base, seeded.workspaceId, false)).status).toBe(409);
    expect((await deleteWorkspace(base, seeded.workspaceId, true)).status).toBe(200);
    expect(db.getWorkspace(seeded.workspaceId)).toBeUndefined();
  });

  it('deletes an empty non-default workspace', async () => {
    const db = openDb();
    const startup = db.seedDefaultWorkspace(process.cwd(), 'ask');
    if (!startup) throw new Error('expected a seeded workspace');
    const workspace = db.createWorkspace({ name: 'empty', path: '/srv/empty' });
    const base = await startApi(db);

    const res = await deleteWorkspace(base, workspace.id, false);

    expect(res.status).toBe(200);
    expect(res.body.deletedSessions).toBe(0);
    expect(db.listWorkspaces().map((w) => w.id)).toEqual([startup.id]);
  });
});
