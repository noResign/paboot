import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent, addToSession } from '../src/agents/index';
import { Db } from '../src/db/db';

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(): { db: Db; workspacePath: string } {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-agent-lifecycle-'));
  dirs.push(workspacePath);
  const db = new Db(':memory:');
  dbs.push(db);
  return { db, workspacePath };
}

function seedWork(db: Db, workspacePath: string): { workspaceId: string; sessionId: string; agentId: string } {
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });
  const session = db.createSession({
    id: 's1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  const member = createAgent(db, workspace, {
    workspaceId: workspace.id,
    name: '审阅',
    kind: 'runtime',
    runtime: 'codex',
    readOnly: true,
  });
  addToSession(db, { id: session.id, workspaceId: workspace.id }, member.id);
  return { workspaceId: workspace.id, sessionId: session.id, agentId: member.id };
}

describe('multi-agent data lifecycle', () => {
  it('deletes turns, tasks, memberships and threads with their session', () => {
    const { db, workspacePath } = openDb();
    const { sessionId, agentId } = seedWork(db, workspacePath);
    db.createTurn({ id: 'turn-1', sessionId, prompt: 'hi', tokenLimit: 0, now: Date.now() });
    db.createTask({
      id: 'task-1',
      sessionId,
      turnId: 'turn-1',
      agentId,
      source: 'mention',
      prompt: 'hi',
      needsWrite: false,
      snapshotSeq: 0,
      now: Date.now(),
    });
    db.appendEvent('room:s1', 1, 'status', { type: 'status', label: 'starting' }, {
      sessionId,
      roomSeq: 1,
    });

    db.deleteSession(sessionId);

    expect(db.listTurns(sessionId, null, 10)).toHaveLength(0);
    expect(db.listTasksByTurn('turn-1')).toHaveLength(0);
    expect(db.listSessionAgents(sessionId)).toHaveLength(0);
    expect(db.listAgentThreads(sessionId)).toHaveLength(0);
    expect(db.listRoomEvents(sessionId)).toHaveLength(0);
  });

  it('removes workspace agents when the workspace itself is deleted', () => {
    const { db, workspacePath } = openDb();
    const { workspaceId } = seedWork(db, workspacePath);

    db.deleteWorkspace(workspaceId);

    expect(db.getWorkspace(workspaceId)).toBeUndefined();
    expect(db.listAgents(workspaceId)).toHaveLength(0);
  });

  it('reconciles orphaned tasks and turns when the daemon restarts', () => {
    const { db, workspacePath } = openDb();
    const { sessionId, agentId } = seedWork(db, workspacePath);
    db.createTurn({ id: 'turn-1', sessionId, prompt: 'hi', tokenLimit: 0, now: Date.now() });
    db.createTask({
      id: 'task-1',
      sessionId,
      turnId: 'turn-1',
      agentId,
      source: 'mention',
      prompt: 'hi',
      needsWrite: false,
      snapshotSeq: 0,
      now: Date.now(),
    });
    db.updateTask('task-1', { status: 'running', startedAt: Date.now() });
    db.createRun({
      id: 'run-1',
      sessionId,
      runtime: 'codex',
      model: null,
      prompt: 'hi',
      status: 'running',
      taskId: 'task-1',
      turnId: 'turn-1',
    });

    expect(db.interruptOrphanedRuns('daemon restarted during the run')).toBe(1);
    expect(db.getRun('run-1')!.status).toBe('interrupted');
    expect(db.getTask('task-1')!.status).toBe('failed');
    expect(db.getTurn('turn-1')!.status).toBe('failed');
  });

  it('reconciles queued tasks even when no run row was ever created', () => {
    const { db, workspacePath } = openDb();
    const { sessionId, agentId } = seedWork(db, workspacePath);
    db.createTurn({ id: 'turn-1', sessionId, prompt: 'hi', tokenLimit: 0, now: Date.now() });
    db.createTask({
      id: 'task-1',
      sessionId,
      turnId: 'turn-1',
      agentId,
      source: 'mention',
      prompt: 'hi',
      needsWrite: false,
      snapshotSeq: 0,
      now: Date.now(),
    });

    expect(db.interruptOrphanedRuns('daemon restarted')).toBe(0);
    expect(db.getTask('task-1')!.status).toBe('failed');
    expect(db.getTurn('turn-1')!.status).toBe('failed');
  });
});
