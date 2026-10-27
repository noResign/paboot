import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db';

const dbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(file = ':memory:'): Db {
  const db = new Db(file);
  dbs.push(db);
  return db;
}

function seed(db: Db): { workspaceId: string; sessionId: string } {
  const workspace = db.createWorkspace({ name: 'demo', path: '/tmp/paboot-demo' });
  const session = db.createSession({
    id: 'session-1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  return { workspaceId: workspace.id, sessionId: session.id };
}

function createTask(
  db: Db,
  workspaceId: string,
  overrides: Partial<Parameters<Db['createScheduledTask']>[0]> = {},
): ReturnType<Db['createScheduledTask']> {
  return db.createScheduledTask({
    id: 'task-1',
    name: 'daily',
    taskType: 'ai',
    sessionMode: 'existing',
    sessionId: 'session-1',
    workspaceId,
    runtime: 'claude',
    prompt: 'do it',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    nextRunAt: 1000,
    createdBy: 'user',
    ...overrides,
  });
}

describe('scheduled task DB', () => {
  it('creates, reads and lists tasks', () => {
    const db = openDb();
    const { workspaceId } = seed(db);
    createTask(db, workspaceId);

    expect(db.getScheduledTask('task-1')).toMatchObject({
      name: 'daily',
      enabled: 1,
      next_run_at: 1000,
      last_status: 'never',
    });
    expect(db.listScheduledTasks({ workspaceId })).toHaveLength(1);
    expect(db.listScheduledTasks({ sessionId: 'session-1' })).toHaveLength(1);
    expect(db.listDueScheduledTasks(1000)).toHaveLength(1);
    expect(db.listDueScheduledTasks(999)).toHaveLength(0);
  });

  it('advances a slot with compare-and-swap exactly once', () => {
    const db = openDb();
    const { workspaceId } = seed(db);
    createTask(db, workspaceId);

    expect(
      db.advanceScheduledTask('task-1', 1000, { nextRunAt: 2000, lastStatus: 'running' }),
    ).toBe(true);
    expect(
      db.advanceScheduledTask('task-1', 1000, { nextRunAt: 3000, lastStatus: 'running' }),
    ).toBe(false);
    expect(db.getScheduledTask('task-1')?.next_run_at).toBe(2000);
  });

  it('binds a lazily-created session once', () => {
    const db = openDb();
    const { workspaceId } = seed(db);
    createTask(db, workspaceId, { sessionId: null, sessionMode: 'new' });

    expect(db.setScheduledTaskSession('task-1', 'new-session-a')).toBe(true);
    expect(db.setScheduledTaskSession('task-1', 'new-session-b')).toBe(false);
    expect(db.getScheduledTask('task-1')?.session_id).toBe('new-session-a');
  });

  it('deletes session-bound tasks when their session is deleted', () => {
    const db = openDb();
    const { workspaceId, sessionId } = seed(db);
    createTask(db, workspaceId);
    createTask(db, workspaceId, {
      id: 'task-2',
      name: 'new-session task',
      sessionId: null,
      sessionMode: 'new',
    });

    db.deleteSession(sessionId);
    expect(db.getScheduledTask('task-1')).toBeUndefined();
    expect(db.getScheduledTask('task-2')?.enabled).toBe(1);

    db.deleteWorkspace(workspaceId);
    expect(db.getScheduledTask('task-2')).toMatchObject({
      enabled: 0,
      disabled_reason: 'workspace_deleted',
    });
  });

  it('cleans up tasks whose bound session no longer exists', () => {
    const db = openDb();
    const { workspaceId } = seed(db);
    createTask(db, workspaceId);
    createTask(db, workspaceId, { id: 'ghost', name: 'ghost', sessionId: 'missing-session' });
    createTask(db, workspaceId, { id: 'new', name: 'new', sessionId: null, sessionMode: 'new' });

    expect(db.deleteOrphanedScheduledTasks()).toBe(1);
    expect(db.getScheduledTask('task-1')).toBeDefined();
    expect(db.getScheduledTask('ghost')).toBeUndefined();
    expect(db.getScheduledTask('new')).toBeDefined();
  });

  it('hides command sessions from client-facing lists and counts', () => {
    const db = openDb();
    const { workspaceId } = seed(db);
    const commandSession = db.createSession({
      id: 'command-session',
      runtime: 'command',
      workspaceId,
      permissionMode: 'bypass',
      cwd: '/tmp/paboot-demo',
      kind: 'command',
    });

    expect(commandSession.kind).toBe('command');
    expect(db.listSessions().map((s) => s.id)).toEqual(['session-1']);
    expect(db.listAllSessions()).toHaveLength(2);
    expect(db.countSessionsByWorkspace().get(workspaceId)).toBe(1);
  });

  it('records run trigger metadata and lists runs by task', () => {
    const db = openDb();
    const { workspaceId, sessionId } = seed(db);
    createTask(db, workspaceId);

    db.createRun({
      id: 'run-1',
      sessionId,
      runtime: 'claude',
      model: null,
      prompt: 'first',
      status: 'succeeded',
      taskId: 'task-1',
      trigger: 'scheduled',
      permissionMode: 'bypass',
    });
    db.createRun({
      id: 'run-2',
      sessionId,
      runtime: 'claude',
      model: null,
      prompt: 'second',
      status: 'succeeded',
      taskId: 'task-1',
      trigger: 'run_now',
      permissionMode: 'bypass',
    });

    expect(db.getRun('run-1')).toMatchObject({
      task_id: 'task-1',
      trigger: 'scheduled',
      permission_mode: 'bypass',
    });
    expect(db.listRunsByTask('task-1').map((run) => run.id)).toEqual(['run-2', 'run-1']);
  });

  it('keeps task data across a reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-tasks-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'db.sqlite');

    const first = new Db(file);
    const { workspaceId } = seed(first);
    createTask(first, workspaceId);
    first.close();

    const second = new Db(file);
    dbs.push(second);
    expect(second.getScheduledTask('task-1')?.name).toBe('daily');
  });
});
