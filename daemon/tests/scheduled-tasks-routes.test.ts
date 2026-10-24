import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context';
import { Db } from '../src/db';
import { PermissionManager } from '../src/permissions';
import { registerScheduledTaskRoutes } from '../src/routes/scheduled-tasks';
import { RunNotifier } from '../src/run-notifier';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';

const servers: Server[] = [];
const dbs: Db[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const db of dbs.splice(0)) db.close();
});

interface Harness {
  db: Db;
  base: string;
  sessionId: string;
  workspaceId: string;
  starts: RuntimeDriverRequest[];
}

async function setup(): Promise<Harness> {
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.createWorkspace({ name: 'demo', path: '/tmp/paboot-routes' });
  const session = db.createSession({
    id: 'session-1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  const starts: RuntimeDriverRequest[] = [];
  const driver: RuntimeDriver = {
    id: 'claude',
    start(req) {
      starts.push(req);
      return {
        id: req.runId,
        promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
        cancel: () => {},
      };
    },
  };
  const ctx = {
    db,
    registry: {
      driver: (id: string) => (id === 'claude' ? driver : undefined),
      detection: () => ({ available: true }),
      detect: async () => ({ available: true }),
      list: () => [{ id: 'claude', name: 'Claude Code', bin: 'claude' }],
    },
    permissions: new PermissionManager(),
    notifier: new RunNotifier(),
    config: {},
    hookPath: '',
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerScheduledTaskRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, sessionId: session.id, workspaceId: workspace.id, starts };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function aiBody(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'daily report',
    type: 'ai',
    prompt: 'summarize',
    target: { mode: 'existing', sessionId },
    schedule: { preset: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
    ...overrides,
  };
}

describe('scheduled task routes', () => {
  it('creates, lists and reads an AI task', async () => {
    const h = await setup();
    const created = await fetch(`${h.base}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiBody(h.sessionId)),
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.task).toMatchObject({
      name: 'daily report',
      type: 'ai',
      sessionId: h.sessionId,
      enabled: true,
      createdBy: 'user',
      schedule: { cron: '0 9 * * *', timezone: 'Asia/Shanghai', label: '每天 09:00' },
    });
    expect(body.task.nextRunAt).toBeGreaterThan(Date.now());

    const list = await json(await fetch(`${h.base}/api/scheduled-tasks?sessionId=${h.sessionId}`));
    expect(list.tasks).toHaveLength(1);

    const detail = await json(await fetch(`${h.base}/api/scheduled-tasks/${body.task.id}`));
    expect(detail.task.id).toBe(body.task.id);
    expect(detail.runs).toEqual([]);
  });

  it('rejects an invalid schedule', async () => {
    const h = await setup();
    const response = await fetch(`${h.base}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiBody(h.sessionId, { schedule: { cron: 'not a cron' } })),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: 'schedule_invalid' });
  });

  it('creates a hidden session for command tasks and removes it with the task', async () => {
    const h = await setup();
    const created = await fetch(`${h.base}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'nightly',
        type: 'command',
        command: 'printf hi',
        target: { mode: 'workspace', workspaceId: h.workspaceId },
        schedule: { preset: 'every_hours', every: 6, timezone: 'Asia/Shanghai' },
      }),
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.task.type).toBe('command');
    expect(body.task.schedule).toMatchObject({ cron: '0 */6 * * *', label: '每 6 小时' });

    const hidden = h.db.getSession(body.task.sessionId);
    expect(hidden).toMatchObject({ kind: 'command', runtime: 'command' });
    expect(h.db.listSessions()).toHaveLength(1); // only the visible user session
    expect(h.db.listAllSessions()).toHaveLength(2);

    const removed = await fetch(`${h.base}/api/scheduled-tasks/${body.task.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(h.db.getSession(body.task.sessionId)).toBeUndefined();
    expect(h.db.getScheduledTask(body.task.id)).toBeUndefined();
  });

  it('disables and re-enables a task, and deletes it with its session', async () => {
    const h = await setup();
    const body = await json(
      await fetch(`${h.base}/api/scheduled-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiBody(h.sessionId)),
      }),
    );
    const id = body.task.id;

    const disabled = await json(
      await fetch(`${h.base}/api/scheduled-tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(disabled.task.enabled).toBe(false);
    expect(disabled.task.nextRunAt).toBeNull();

    const enabled = await json(
      await fetch(`${h.base}/api/scheduled-tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(enabled.task.enabled).toBe(true);
    expect(enabled.task.nextRunAt).toBeGreaterThan(Date.now());

    h.db.deleteSession(h.sessionId);
    expect(h.db.getScheduledTask(id)).toBeUndefined();
    const rejected = await fetch(`${h.base}/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(rejected.status).toBe(404);
    expect(await json(rejected)).toMatchObject({ code: 'task_not_found' });
  });

  it('runs a task immediately without advancing its schedule', async () => {
    const h = await setup();
    const body = await json(
      await fetch(`${h.base}/api/scheduled-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiBody(h.sessionId)),
      }),
    );
    const id = body.task.id;
    const nextRunAt = body.task.nextRunAt;

    const response = await fetch(`${h.base}/api/scheduled-tasks/${id}/run-now`, { method: 'POST' });
    expect(response.status).toBe(202);
    const result = await json(response);
    expect(result).toMatchObject({ ok: true, sessionId: h.sessionId });
    await vi.waitFor(() => expect(h.starts).toHaveLength(1));
    await vi.waitFor(() => expect(h.db.getRun(result.runId)?.status).not.toBe('running'));
    const task = h.db.getScheduledTask(id)!;
    expect(task.next_run_at).toBe(nextRunAt);
    expect(task.last_run_id).toBe(result.runId);
    const run = h.db.getRun(result.runId)!;
    expect(run).toMatchObject({ task_id: id, trigger: 'run_now', permission_mode: 'bypass' });
  });

  it('enforces the per-session task limit', async () => {
    const h = await setup();
    for (let i = 0; i < 20; i += 1) {
      h.db.createScheduledTask({
        id: `seed-${i}`,
        name: `seed ${i}`,
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
    }
    const response = await fetch(`${h.base}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiBody(h.sessionId)),
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'task_limit_reached' });
  });

  it('reuses one AI config session per workspace', async () => {
    const h = await setup();
    const start = () =>
      fetch(`${h.base}/api/scheduled-tasks/config-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: h.workspaceId }),
      });

    const first = await start();
    expect(first.status).toBe(202);
    const firstBody = await json(first);
    expect(firstBody).toMatchObject({ ok: true, busy: false });
    expect(h.db.getSession(firstBody.sessionId)).toMatchObject({
      title: '配置定时任务',
      kind: 'chat',
      workspace_id: h.workspaceId,
    });
    const firstRun = h.db.getRun(firstBody.runId)!;
    expect(firstRun).toMatchObject({ trigger: 'user', permission_mode: 'ask' });
    expect(firstRun.prompt).toContain('[定时任务配置模式]');
    await vi.waitFor(() => {
      expect(h.db.getRun(firstBody.runId)?.status).not.toBe('running');
    });

    const second = await start();
    expect(second.status).toBe(202);
    const secondBody = await json(second);
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    expect(secondBody.busy).toBe(false);
    await vi.waitFor(() => {
      expect(h.db.getRun(secondBody.runId)?.status).not.toBe('running');
    });
    expect(h.db.listSessions().filter((session) => session.workspace_id === h.workspaceId)).toHaveLength(2);
  });
});
