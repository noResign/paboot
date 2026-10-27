import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { registerMcpTaskRoutes } from '../src/routes/mcp-tasks';

const servers: Server[] = [];
const dbs: Db[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const db of dbs.splice(0)) db.close();
});

async function setup() {
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.createWorkspace({ name: 'demo', path: '/tmp/paboot-mcp' });
  const session = db.createSession({
    id: 'session-1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  const other = db.createSession({
    id: 'session-2',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  db.createRun({
    id: 'run-1',
    sessionId: session.id,
    runtime: 'claude',
    model: null,
    prompt: 'hello',
    status: 'succeeded',
    trigger: 'user',
  });
  db.createRun({
    id: 'scheduled-run',
    sessionId: session.id,
    runtime: 'claude',
    model: null,
    prompt: 'scheduled',
    status: 'succeeded',
    trigger: 'scheduled',
  });

  const app = express();
  app.use(express.json());
  registerMcpTaskRoutes(app, {
    db,
    registry: {
      driver: (id: string) => (id === 'claude' || id === 'codex' ? { id } : undefined),
    },
  } as unknown as AppContext);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    db,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sessionId: session.id,
    otherSessionId: other.id,
    workspaceId: workspace.id,
  };
}

describe('agent-facing scheduled task routes', () => {
  it('creates a task scoped to the calling run session', async () => {
    const h = await setup();
    const response = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-1',
        name: 'daily',
        prompt: 'summarize',
        schedule: { preset: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
        // A prompt-injected agent must not be able to choose another session.
        sessionId: h.otherSessionId,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.task).toMatchObject({
      name: 'daily',
      type: 'ai',
      sessionId: h.sessionId,
      createdBy: 'mcp',
      enabled: true,
    });
    expect(body.task.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('blocks task creation from a scheduled run', async () => {
    const h = await setup();
    const response = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'scheduled-run',
        name: 'recursive',
        prompt: 'again',
        schedule: { preset: 'daily', time: '09:00' },
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'recursion_blocked' });
  });

  it('lists all tasks in the calling workspace', async () => {
    const h = await setup();
    h.db.createScheduledTask({
      id: 'mine',
      name: 'mine',
      taskType: 'ai',
      sessionMode: 'existing',
      sessionId: h.sessionId,
      workspaceId: h.workspaceId,
      runtime: 'claude',
      prompt: 'x',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: Date.now() + 60_000,
      createdBy: 'user',
    });
    h.db.createScheduledTask({
      id: 'other',
      name: 'other',
      taskType: 'ai',
      sessionMode: 'existing',
      sessionId: h.otherSessionId,
      workspaceId: h.workspaceId,
      runtime: 'claude',
      prompt: 'x',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: Date.now() + 60_000,
      createdBy: 'user',
    });
    const otherWorkspace = h.db.createWorkspace({ name: 'other', path: '/tmp/paboot-mcp-other' });
    h.db.createScheduledTask({
      id: 'foreign',
      name: 'foreign',
      taskType: 'ai',
      sessionMode: 'new',
      sessionId: null,
      workspaceId: otherWorkspace.id,
      runtime: 'claude',
      prompt: 'x',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: Date.now() + 60_000,
      createdBy: 'user',
    });

    const body = await (
      await fetch(`${h.base}/api/internal/mcp/scheduled-tasks?runId=run-1`)
    ).json();
    expect(body.currentSessionId).toBe(h.sessionId);
    expect(body.tasks.map((task: { id: string }) => task.id).sort()).toEqual(['mine', 'other']);
  });

  it('cancels another session task in the same workspace', async () => {
    const h = await setup();
    h.db.createScheduledTask({
      id: 'other',
      name: 'other',
      taskType: 'ai',
      sessionMode: 'existing',
      sessionId: h.otherSessionId,
      workspaceId: h.workspaceId,
      runtime: 'claude',
      prompt: 'x',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: Date.now() + 60_000,
      createdBy: 'user',
    });

    const response = await fetch(`${h.base}/api/internal/mcp/scheduled-tasks/other/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-1' }),
    });
    expect(response.status).toBe(200);
    expect(h.db.getScheduledTask('other')).toBeUndefined();
  });

  it('refuses to cancel a task from another workspace', async () => {
    const h = await setup();
    const otherWorkspace = h.db.createWorkspace({ name: 'other', path: '/tmp/paboot-mcp-other' });
    h.db.createScheduledTask({
      id: 'foreign',
      name: 'foreign',
      taskType: 'ai',
      sessionMode: 'new',
      sessionId: null,
      workspaceId: otherWorkspace.id,
      runtime: 'claude',
      prompt: 'x',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: Date.now() + 60_000,
      createdBy: 'user',
    });

    const response = await fetch(`${h.base}/api/internal/mcp/scheduled-tasks/foreign/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-1' }),
    });
    expect(response.status).toBe(404);
    expect(h.db.getScheduledTask('foreign')).toBeDefined();
  });

  it('rejects an unknown run and invalid input', async () => {
    const h = await setup();
    const unknown = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'nope', name: 'x', prompt: 'y', schedule: { preset: 'daily', time: '09:00' } }),
    });
    expect(unknown.status).toBe(404);

    const invalid = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-1', name: '', prompt: 'y', schedule: { preset: 'daily', time: '09:00' } }),
    });
    expect(invalid.status).toBe(400);
  });

  it('creates a task on an existing session target', async () => {
    const h = await setup();
    const response = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-1',
        name: 'other task',
        prompt: 'do it',
        schedule: { preset: 'daily', time: '09:00' },
        target: { mode: 'existing', sessionId: h.otherSessionId },
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.task).toMatchObject({
      sessionMode: 'existing',
      sessionId: h.otherSessionId,
    });
  });

  it('creates a new-session task target', async () => {
    const h = await setup();
    const response = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-1',
        name: 'fresh task',
        prompt: 'do it',
        schedule: { preset: 'daily', time: '09:00' },
        target: { mode: 'new', runtime: 'claude' },
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.task).toMatchObject({
      sessionMode: 'new',
      sessionId: null,
      runtime: 'claude',
    });
  });

  it('rejects a target session from another workspace', async () => {
    const h = await setup();
    const otherWorkspace = h.db.createWorkspace({ name: 'other', path: '/tmp/paboot-mcp-other' });
    const otherSession = h.db.createSession({
      id: 'foreign-session',
      runtime: 'claude',
      workspaceId: otherWorkspace.id,
      permissionMode: 'ask',
      cwd: otherWorkspace.path,
    });
    const response = await fetch(`${h.base}/api/internal/mcp/schedule-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-1',
        name: 'foreign',
        prompt: 'do it',
        schedule: { preset: 'daily', time: '09:00' },
        target: { mode: 'existing', sessionId: otherSession.id },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'target_not_found' });
  });

  it('lists only sessions in the calling workspace', async () => {
    const h = await setup();
    const otherWorkspace = h.db.createWorkspace({ name: 'other', path: '/tmp/paboot-mcp-other' });
    h.db.createSession({
      id: 'foreign-session',
      runtime: 'claude',
      workspaceId: otherWorkspace.id,
      permissionMode: 'ask',
      cwd: otherWorkspace.path,
    });

    const response = await fetch(`${h.base}/api/internal/mcp/sessions?runId=run-1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.currentSessionId).toBe(h.sessionId);
    expect(body.sessions.map((session: { id: string }) => session.id).sort()).toEqual([
      'session-1',
      'session-2',
    ]);
  });
});
