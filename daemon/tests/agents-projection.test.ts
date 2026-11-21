import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addToSession,
  buildRoomProjection,
  createAgent,
  getLeader,
  ROOM_CONTEXT_MAX_CHARS,
} from '../src/agents/index';
import { Db } from '../src/db/db';

/**
 * The room projection is the only way one agent learns what the others said:
 * its own thread holds its own turns only. These tests pin the three rules that
 * make it trustworthy — committed only, never its own words, and an explicit
 * account of what was left out.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Room {
  db: Db;
  sessionId: string;
  me: string;
  other: string;
}

function makeRoom(title = '重构登录'): Room {
  const dir = fs.realpathSync(tempDir('paboot-projection-'));
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: dir });
  const session = db.createSession({
    id: 's1',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: dir,
    title,
  });
  const me = getLeader(db, session.id)!;
  const other = createAgent(db, workspace, {
    workspaceId: workspace.id,
    name: '审阅',
    kind: 'builtin',
    readOnly: true,
  });
  addToSession(db, { id: session.id, workspaceId: workspace.id }, other.id);
  return { db, sessionId: session.id, me: me.id, other: other.id };
}

function say(room: Room, role: 'user' | 'assistant', content: string, agentId?: string): number {
  return room.db.addMessage(room.sessionId, role, content, {
    agentId: agentId ?? null,
    commit: true,
  })!;
}

function project(room: Room, snapshotSeq: number, sinceSeq = 0, agentId = room.me) {
  return buildRoomProjection(room.db, {
    sessionId: room.sessionId,
    sessionTitle: '重构登录',
    agentId,
    snapshotSeq,
    sinceSeq,
  });
}

describe('room projection', () => {
  it('shows the others in timeline order and never the agent itself', () => {
    const room = makeRoom();
    say(room, 'user', '帮我看看这段代码');
    say(room, 'assistant', '有三个问题：缺少错误处理、竞态、没有单测', room.other);
    say(room, 'assistant', '我来补 try/catch', room.me);

    const text = project(room, 3)!;
    expect(text).toContain('session="群聊：重构登录"');
    expect(text).toContain('since="3"');
    expect(text).toContain('omitted="0"');
    expect(text).toContain('[用户] 帮我看看这段代码');
    expect(text).toContain('[审阅] 有三个问题');
    expect(text).not.toContain('我来补 try/catch');
    expect(text.indexOf('[用户]')).toBeLessThan(text.indexOf('[审阅]'));
  });

  it('is bounded by both the snapshot and the thread cursor', () => {
    const room = makeRoom();
    say(room, 'user', '第一条');
    say(room, 'assistant', '第二条', room.other);

    // A snapshot from before the others spoke sees only what existed then.
    expect(project(room, 1)).toContain('[用户] 第一条');
    expect(project(room, 1)).not.toContain('[审阅] 第二条');
    // A cursor that already covers the timeline yields nothing.
    expect(project(room, 2, 2)).toBeNull();
    // The agent's own words are excluded, so only the sibling remains.
    const own = project(room, 2, 0, room.other)!;
    expect(own).toContain('[用户] 第一条');
    expect(own).not.toContain('[审阅] 第二条');
  });

  it('keeps the newest six and says how many it dropped', () => {
    const room = makeRoom();
    say(room, 'user', '最早的提问');
    for (let i = 1; i <= 10; i += 1) {
      say(room, 'assistant', `第 ${i} 条回答`, room.other);
    }

    const text = project(room, 11)!;
    expect(text).toContain('omitted="5"');
    expect(text).toContain('（更早的 5 条已省略，未逐条列出）');
    expect(text).toContain('[审阅] 第 10 条回答');
    expect(text).toContain('[审阅] 第 5 条回答');
    expect(text).not.toContain('[审阅] 第 4 条回答');
    expect(text).not.toContain('最早的提问');
    // Six verbatim entries at most.
    expect(text.match(/\[审阅\]/g)).toHaveLength(6);
  });

  it('clips one oversized answer instead of dropping it, and stays under the cap', () => {
    const room = makeRoom();
    for (let i = 1; i <= 5; i += 1) {
      say(room, 'assistant', `E${i}:` + 'x'.repeat(3000), room.other);
    }

    const text = project(room, 5)!;
    expect(text.length).toBeLessThanOrEqual(ROOM_CONTEXT_MAX_CHARS);
    expect(text).toContain('E5:');
    expect(text).toContain('（已截断）');
    expect(text).toContain('omitted="4"');
  });

  it('is null when there is nothing to show', () => {
    const room = makeRoom();
    expect(project(room, 0)).toBeNull();
  });
});
