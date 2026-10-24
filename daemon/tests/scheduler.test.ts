import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context';
import { Db, type ScheduledTaskRow } from '../src/db';
import { PermissionManager } from '../src/permissions';
import { RunNotifier } from '../src/run-notifier';
import { createCommandDriver } from '../src/runtimes/command';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { fireScheduledTask, reconcileScheduledTasks, runDueScheduledTasks } from '../src/scheduler';

// A real, non-git directory: the command runner needs an existing cwd, and we
// must not snapshot the paboot repo itself.
const WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-scheduler-'));

afterAll(() => {
  fs.rmSync(WORKSPACE_PATH, { recursive: true, force: true });
});

interface Harness {
  ctx: AppContext;
  db: Db;
  workspaceId: string;
  starts: RuntimeDriverRequest[];
  task: (overrides?: Partial<Parameters<Db['createScheduledTask']>[0]>) => ScheduledTaskRow;
  sessionId: string;
}

function harness(driver?: RuntimeDriver, detectionAvailable = true): Harness {
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: WORKSPACE_PATH });
  const session = db.createSession({
    id: 'session-1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: WORKSPACE_PATH,
  });
  const starts: RuntimeDriverRequest[] = [];
  const fakeDriver: RuntimeDriver = driver ?? {
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
      driver: (id: string) => (id === fakeDriver.id ? fakeDriver : undefined),
      detection: () => (detectionAvailable ? { available: true } : undefined),
      detect: async () => (detectionAvailable ? { available: true } : { available: false }),
    },
    permissions: new PermissionManager(),
    notifier: new RunNotifier(),
    config: {},
    hookPath: '',
  } as unknown as AppContext;

  const task = (overrides: Partial<Parameters<Db['createScheduledTask']>[0]> = {}): ScheduledTaskRow =>
    db.createScheduledTask({
      id: `task-${Math.random()}`,
      name: 'daily',
      taskType: 'ai',
      sessionMode: 'existing',
      sessionId: session.id,
      workspaceId: workspace.id,
      runtime: 'claude',
      prompt: 'do it',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: Date.now(),
      createdBy: 'user',
      ...overrides,
    });

  return { ctx, db, workspaceId: workspace.id, starts, task, sessionId: session.id };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('scheduler', () => {
  it('fires a due task as a scheduled bypass run and advances the slot', async () => {
    const h = harness();
    const task = h.task({ nextRunAt: Date.now() - 1000 });
    const now = Date.now();

    const result = await fireScheduledTask(h.ctx, task.id, 'scheduled', now);
    expect(result.ok).toBe(true);
    await settle();

    const run = h.db.listRuns(h.sessionId)[0];
    expect(run).toMatchObject({
      task_id: task.id,
      trigger: 'scheduled',
      permission_mode: 'bypass',
      status: 'succeeded',
    });
    const updated = h.db.getScheduledTask(task.id)!;
    expect(updated.next_run_at).toBeGreaterThan(now);
    expect(updated.last_status).toBe('succeeded');
    expect(updated.run_count).toBe(1);
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0].permissionMode).toBe('bypass');
    h.db.close();
  });

  it('creates a new-session task session once and resumes it afterwards', async () => {
    const h = harness();
    const task = h.task({
      sessionId: null,
      sessionMode: 'new',
      nextRunAt: Date.now() - 1000,
    });

    const first = await fireScheduledTask(h.ctx, task.id, 'scheduled', Date.now());
    await settle();
    expect(first.ok).toBe(true);
    const bound = h.db.getScheduledTask(task.id)!.session_id;
    expect(bound).not.toBeNull();
    expect(h.db.listSessions()).toHaveLength(2); // user session + task session

    h.db.updateScheduledTask(task.id, { nextRunAt: Date.now() - 1000 });
    const second = await fireScheduledTask(h.ctx, task.id, 'scheduled', Date.now());
    await settle();
    expect(second.ok).toBe(true);
    expect(h.db.getScheduledTask(task.id)!.session_id).toBe(bound);
    expect(h.db.listSessions()).toHaveLength(2);
    expect(h.starts.map((req) => req.sessionId)).toEqual([bound, bound]);
    h.db.close();
  });

  it('skips a fire while the session is busy', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      id: 'claude',
      start(req) {
        h.starts.push(req);
        return {
          id: req.runId,
          promise: pending.then(() => ({ status: 'succeeded' as const, exitCode: 0, error: null })),
          cancel: () => {},
        };
      },
    });
    const task = h.task({ nextRunAt: Date.now() - 1000 });
    const first = await fireScheduledTask(h.ctx, task.id, 'scheduled', Date.now());
    expect(first.ok).toBe(true);

    h.db.updateScheduledTask(task.id, { nextRunAt: Date.now() - 1000 });
    const second = await fireScheduledTask(h.ctx, task.id, 'scheduled', Date.now());
    expect(second).toMatchObject({ ok: false, code: 'busy' });
    expect(h.db.getScheduledTask(task.id)!.last_status).toBe('skipped_busy');

    release();
    await settle();
    h.db.close();
  });

  it('deletes a task whose bound session no longer exists', async () => {
    const h = harness();
    const task = h.task({ sessionId: 'ghost-session' });

    // Defensive path: a dangling task (e.g. a legacy row) is removed instead of
    // being left in the list or starting an orphan run.
    const result = await fireScheduledTask(h.ctx, task.id, 'run_now', Date.now());
    expect(result).toMatchObject({ ok: false, code: 'session_deleted' });
    expect(h.db.getScheduledTask(task.id)).toBeUndefined();
    expect(h.starts).toHaveLength(0);
    h.db.close();
  });

  it('advances missed occurrences instead of replaying them', () => {
    const h = harness();
    const now = Date.now();
    const task = h.task({ nextRunAt: now - 24 * 60 * 60 * 1000 });

    reconcileScheduledTasks(h.ctx, now);

    const updated = h.db.getScheduledTask(task.id)!;
    expect(updated.next_run_at).toBeGreaterThan(now);
    expect(updated.last_status).toBe('skipped_missed');
    expect(h.starts).toHaveLength(0);
    h.db.close();
  });

  it('runs only due tasks on a tick', async () => {
    const h = harness();
    const due = h.task({ id: 'due', nextRunAt: Date.now() - 1000 });
    const future = h.task({ id: 'future', nextRunAt: Date.now() + 60_000 });

    await runDueScheduledTasks(h.ctx, Date.now());
    await settle();

    expect(h.db.getScheduledTask(due.id)!.run_count).toBe(1);
    expect(h.db.getScheduledTask(future.id)!.run_count).toBe(0);
    h.db.close();
  });

  it('does not fire the same slot twice', async () => {
    const h = harness();
    const now = Date.now();
    const task = h.task({ nextRunAt: now - 1000 });

    const [a, b] = await Promise.all([
      fireScheduledTask(h.ctx, task.id, 'scheduled', now),
      fireScheduledTask(h.ctx, task.id, 'scheduled', now),
    ]);
    await settle();

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(h.db.listRuns(h.sessionId)).toHaveLength(1);
    h.db.close();
  });

  it('runs a command task through the command driver', async () => {
    const h = harness(createCommandDriver());
    const commandSession = h.db.createSession({
      id: 'command-session',
      runtime: 'command',
      workspaceId: h.workspaceId,
      permissionMode: 'bypass',
      cwd: WORKSPACE_PATH,
      kind: 'command',
    });
    const task = h.task({
      taskType: 'command',
      sessionMode: 'internal',
      sessionId: commandSession.id,
      runtime: 'command',
      prompt: null,
      command: 'printf hi',
      nextRunAt: Date.now() - 1000,
    });

    const result = await fireScheduledTask(h.ctx, task.id, 'scheduled', Date.now());
    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(h.db.listRuns(commandSession.id)[0]?.status).toBe('succeeded');
    });

    const run = h.db.listRuns(commandSession.id)[0];
    expect(run).toMatchObject({ task_id: task.id, trigger: 'scheduled' });
    expect(h.db.getScheduledTask(task.id)!.last_status).toBe('succeeded');
    h.db.close();
  });

  it('records a failure when the runtime is unavailable', async () => {
    const h = harness(undefined, false);
    const task = h.task({ nextRunAt: Date.now() - 1000 });

    const result = await fireScheduledTask(h.ctx, task.id, 'scheduled', Date.now());
    expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(h.db.getScheduledTask(task.id)!.last_status).toBe('failed');
    expect(h.starts).toHaveLength(0);
    h.db.close();
  });

  it('does not advance the schedule for a manual run-now', async () => {
    const h = harness();
    const next = Date.now() + 60_000;
    const task = h.task({ nextRunAt: next });

    const result = await fireScheduledTask(h.ctx, task.id, 'run_now', Date.now());
    expect(result.ok).toBe(true);
    await settle();

    expect(h.db.getScheduledTask(task.id)!.next_run_at).toBe(next);
    expect(h.db.listRuns(h.sessionId)[0].trigger).toBe('run_now');
    h.db.close();
  });
});
