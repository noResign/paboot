import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToSession, buildRoomSystem, createAgent, getLeader } from '../src/agents/index';
import { Db } from '../src/db/db';

/**
 * The roster is the other half of room awareness: the projection says what was
 * said, the roster says who could be asked. It must never leak mechanism fields
 * (readOnly, runtime ids) — only what a colleague can do.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoom() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-roster-'));
  tempDirs.push(dir);
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: dir });
  const session = db.createSession({
    id: 's1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: dir,
  });
  const leader = getLeader(db, session.id)!;
  const review = createAgent(db, workspace, {
    workspaceId: workspace.id,
    name: '审阅',
    summary: '代码审查，指出问题，不改代码',
    kind: 'builtin',
    readOnly: true,
  });
  const remote = createAgent(db, workspace, {
    workspaceId: workspace.id,
    name: '远端',
    summary: '对端审查',
    kind: 'peer',
    peerId: 'peer-1',
    remoteAgentId: 'agent-1',
  });
  for (const agent of [review, remote]) {
    addToSession(db, { id: session.id, workspaceId: workspace.id }, agent.id);
  }
  return { db, sessionId: session.id, leader, review, remote };
}

describe('room roster', () => {
  it('gives a member the others, the leader marker and no summoning rights', () => {
    const room = makeRoom();
    const text = buildRoomSystem(room.db, {
      sessionId: room.sessionId,
      selfAgentId: room.review.id,
    })!;

    expect(text).toContain('<room-agents you="审阅">');
    expect(text).toContain('默认（主手）：默认');
    expect(text).toContain('远端（远端）：对端审查');
    expect(text).not.toContain('审阅：代码审查');
    expect(text).not.toContain('<room-routing>');
    // Mechanism fields stay out of the roster.
    expect(text).not.toContain('只读');
    expect(text).not.toContain('builtin');
  });

  it('gives the leader the roster plus the summoning rules', () => {
    const room = makeRoom();
    const text = buildRoomSystem(room.db, {
      sessionId: room.sessionId,
      selfAgentId: room.leader.id,
    })!;

    expect(text).toContain('审阅：代码审查，指出问题，不改代码');
    expect(text).toContain('远端（远端）：对端审查');
    expect(text).toContain('<room-routing>');
    expect(text).toContain('最多 3 个');
    expect(text).not.toContain('默认（主手）');
  });

  it('lets a summoned member reply to the leader once', () => {
    const room = makeRoom();
    const text = buildRoomSystem(room.db, {
      sessionId: room.sessionId,
      selfAgentId: room.review.id,
      canReplyToLeader: true,
    })!;
    expect(text).toContain('<room-reply>');
    expect(text).toContain(`@${room.leader.name}`);
    expect(text).toContain('只允许回报主答一次');
    expect(text).not.toContain('你的 @ 不会召唤任何人');
  });

  it('stops a leader follow-up task from summoning again', () => {
    const room = makeRoom();
    const text = buildRoomSystem(room.db, {
      sessionId: room.sessionId,
      selfAgentId: room.leader.id,
      canSummon: false,
    })!;
    expect(text).toContain('本轮链路到此结束');
    expect(text).not.toContain('最多 3 个');
  });

  it('is absent for a single-assistant session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-roster-solo-'));
    tempDirs.push(dir);
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'solo', path: dir });
    const session = db.createSession({
      id: 's2',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: dir,
    });
    const leader = getLeader(db, session.id)!;
    expect(buildRoomSystem(db, { sessionId: session.id, selfAgentId: leader.id })).toBeNull();
  });
});
