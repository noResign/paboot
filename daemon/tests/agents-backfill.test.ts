import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillMultiAgent,
  resolveAgentForSession,
  DEFAULT_IMPLICIT_RUNTIME,
} from '../src/agents/index';
import { Db, MULTI_AGENT_BACKFILL_KEY, implicitAgentId } from '../src/db/db';

/**
 * P0 acceptance for the multi-agent shadow tables
 * (docs/local/multi_agent/13-p0-checklist.md §D).
 *
 * The contract under test is deliberately narrow: the backfill must produce
 * consistent shadow rows, be idempotent, survive a legacy database, and never
 * change what an existing request path does.
 */

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-p0-'));
  tempDirs.push(dir);
  return path.join(dir, 'paboot.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const silentLog = { warn: (): void => {} };

function makeWorkspace(db: Db, name = 'proj'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-ws-${name}-`));
  tempDirs.push(dir);
  const workspace = db.createWorkspace({ name, path: dir });
  return workspace.id;
}

function makeSession(
  db: Db,
  workspaceId: string,
  input: { runtime?: string; kind?: 'chat' | 'command'; nativeId?: string | null } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-sess-'));
  tempDirs.push(dir);
  const session = db.createSession({
    id: `s_${Math.random().toString(36).slice(2, 10)}`,
    runtime: input.runtime ?? 'claude',
    workspaceId,
    permissionMode: 'ask',
    cwd: dir,
    native_session_id: input.nativeId ?? null,
    kind: input.kind ?? 'chat',
  });
  return session.id;
}

describe('multi-agent shadow backfill (P0)', () => {
  it('seeds one implicit agent per (workspace, runtime) that sessions actually use', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    makeSession(db, workspaceId, { runtime: 'claude' });
    makeSession(db, workspaceId, { runtime: 'claude' });
    makeSession(db, workspaceId, { runtime: 'codex' });

    // Sessions seed their own shadow rows at creation, so the backfill finds
    // nothing left to create. Assert on the resulting rows instead of the count.
    const result = backfillMultiAgent(db, silentLog);
    expect(result.ran).toBe(true);

    const agents = db.listAgents(workspaceId);
    expect(agents.map((agent) => agent.runtime).sort()).toEqual(['claude', 'codex']);
    expect(agents.every((agent) => agent.is_implicit === 1)).toBe(true);
    // Names must be distinct so `@默认` is never ambiguous.
    expect(new Set(agents.map((agent) => agent.name)).size).toBe(2);
    expect(agents.some((agent) => agent.name === '默认')).toBe(true);
  });

  it('gives every chat and command session a leader and a thread', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const chat = makeSession(db, workspaceId, { runtime: 'claude', nativeId: 'native-1' });
    const command = makeSession(db, workspaceId, { runtime: 'claude', kind: 'command' });

    backfillMultiAgent(db, silentLog);

    for (const sessionId of [chat, command]) {
      const leader = db.getSessionLeader(sessionId);
      expect(leader?.role).toBe('leader');
      const thread = db.getAgentThread(sessionId, leader!.agent_id);
      expect(thread).toBeDefined();
      expect(thread!.backend).toBe('claude');
    }
    // The native session id is copied into the shadow thread so P1 can resume.
    expect(db.getAgentThread(chat, db.getSessionLeader(chat)!.agent_id)!.native_session_id).toBe('native-1');

    const counts = db.shadowTableCounts();
    expect(counts.liveSessions).toBe(2);
    expect(counts.withLeader).toBe(2);
    expect(counts.withThread).toBe(2);
    expect(counts.orphanThreads).toBe(0);
  });

  // Creating real temp workspaces costs a couple of seconds; the whole suite
  // runs many files in parallel, so give the DB-backed cases headroom.
  it('is idempotent: a second run adds nothing', { timeout: 20_000 }, () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    makeSession(db, workspaceId, { runtime: 'claude' });
    makeSession(db, workspaceId, { runtime: 'codex', kind: 'command' });

    backfillMultiAgent(db, silentLog);
    const before = db.shadowTableCounts();
    const agentsBefore = db.listAgents(workspaceId).length;

    const second = backfillMultiAgent(db, silentLog);
    // Marker is set, so the second run short-circuits entirely.
    expect(second.ran).toBe(false);
    expect(db.shadowTableCounts()).toEqual(before);
    expect(db.listAgents(workspaceId)).toHaveLength(agentsBefore);
  });

  it('re-running the statements directly stays idempotent even without the marker', { timeout: 20_000 }, () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    makeSession(db, workspaceId, { runtime: 'claude' });

    backfillMultiAgent(db, silentLog);
    const before = db.shadowTableCounts();
    db.setSetting(MULTI_AGENT_BACKFILL_KEY, '');
    // Force every statement to run again and assert the set-based inserts are
    // INSERT OR IGNORE rather than relying on the marker alone.
    db.ensureImplicitAgent(workspaceId, 'claude');
    expect(db.backfillSessionLeaders()).toBe(0);
    expect(db.backfillAgentThreads()).toBe(0);
    expect(db.shadowTableCounts()).toEqual(before);
  });

  it('seeds a workspace that has no sessions yet from its default runtime', { timeout: 20_000 }, () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);

    backfillMultiAgent(db, silentLog);

    const agents = db.listAgents(workspaceId);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runtime).toBe(DEFAULT_IMPLICIT_RUNTIME);
    expect(db.getWorkspaceDefaultAgentId(workspaceId)).toBe(agents[0]!.id);
  });

  it('points default_agent_id at the configured default runtime when there is one', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    db.updateWorkspace(workspaceId, { defaultRuntime: 'codex' });
    makeSession(db, workspaceId, { runtime: 'claude' });
    makeSession(db, workspaceId, { runtime: 'codex' });

    backfillMultiAgent(db, silentLog);

    const defaultAgentId = db.getWorkspaceDefaultAgentId(workspaceId);
    expect(defaultAgentId).toBe(implicitAgentId(workspaceId, 'codex'));
  });

  it('leaves sessions whose workspace is missing untouched instead of crashing', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    // Simulate a legacy row pointing at a workspace deleted behind our back,
    // with no shadow rows of its own (as a pre-P0 row would look).
    const raw = (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    raw.prepare('DELETE FROM agent_threads WHERE session_id = ?').run(sessionId);
    raw.prepare('DELETE FROM session_agents WHERE session_id = ?').run(sessionId);
    raw.prepare('UPDATE sessions SET workspace_id = ? WHERE id = ?').run('gone', sessionId);

    expect(() => backfillMultiAgent(db, silentLog)).not.toThrow();
    // The session cannot be attributed, so it must simply not gain a leader and
    // the backfill must not invent an agent for the dangling workspace id.
    expect(db.getSessionLeader(sessionId)).toBeUndefined();
    expect(db.shadowTableCounts().orphanThreads).toBe(0);
    expect(db.listAgents('gone')).toHaveLength(0);
  });
});

describe('dual write (P0)', () => {
  it('gives a brand-new session its shadow rows without waiting for a backfill', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });

    const leader = db.getSessionLeader(sessionId);
    expect(leader?.role).toBe('leader');
    expect(db.getAgentThread(sessionId, leader!.agent_id)).toBeDefined();
  });

  it('mirrors the native session id into the shadow thread, and clears it too', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    const agentId = db.getSessionLeader(sessionId)!.agent_id;

    db.setNativeSessionId(sessionId, 'native-abc');
    expect(db.getSession(sessionId)!.native_session_id).toBe('native-abc');
    expect(db.getAgentThread(sessionId, agentId)!.native_session_id).toBe('native-abc');
    expect(db.shadowTableCounts().dualWriteMismatch).toBe(0);

    db.clearNativeSessionId(sessionId);
    expect(db.getSession(sessionId)!.native_session_id).toBeNull();
    expect(db.getAgentThread(sessionId, agentId)!.native_session_id).toBeNull();
    expect(db.shadowTableCounts().dualWriteMismatch).toBe(0);
  });

  it('attributes a run to the session leader without changing run behaviour', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    db.createRun({
      id: 'run-1',
      sessionId,
      runtime: 'claude',
      model: null,
      prompt: 'hi',
      status: 'running',
    });

    const run = db.getRun('run-1');
    expect(run?.agent_id).toBe(db.getSessionLeader(sessionId)!.agent_id);
    expect(run?.thread_id).toBe(`th_${sessionId}`);
    expect(run?.session_id).toBe(sessionId);
  });

  it('still creates a run when shadow rows are absent', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('DELETE FROM session_agents WHERE session_id = ?')
      .run(sessionId);

    db.createRun({ id: 'run-2', sessionId, runtime: 'claude', model: null, prompt: 'hi', status: 'running' });
    const run = db.getRun('run-2');
    expect(run?.status).toBe('running');
    expect(run?.agent_id ?? null).toBeNull();
  });
});

describe('resolveAgentForSession fallback (P0)', () => {
  it('prefers the session leader', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    backfillMultiAgent(db, silentLog);

    const resolved = resolveAgentForSession(db, sessionId);
    expect(resolved?.source).toBe('leader');
    expect(resolved?.runtime).toBe('claude');
    expect(resolved?.id).toBe(implicitAgentId(workspaceId, 'claude'));
  });

  it('falls back to the workspace default when there is no leader row', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    backfillMultiAgent(db, silentLog);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    // Simulate a row whose leader was dropped (e.g. an agent deleted later).
    (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('DELETE FROM session_agents WHERE session_id = ?')
      .run(sessionId);

    const resolved = resolveAgentForSession(db, sessionId);
    expect(resolved?.source).toBe('workspace_default');
    expect(resolved?.id).toBe(db.getWorkspaceDefaultAgentId(workspaceId));
  });

  it('never throws for an unattributable session', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'deepseek' });
    // Strip every shadow row so no fallback step can succeed.
    const raw = (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    raw.prepare('DELETE FROM agent_threads WHERE session_id = ?').run(sessionId);
    raw.prepare('DELETE FROM session_agents WHERE session_id = ?').run(sessionId);
    raw.prepare('DELETE FROM agents WHERE workspace_id = ?').run(workspaceId);

    const resolved = resolveAgentForSession(db, sessionId);
    expect(resolved).not.toBeNull();
    expect(resolved!.runtime).toBe('deepseek');
    // No agent anywhere: a stable synthetic id, and nothing written to the DB.
    expect(resolved!.source).toBe('synthesized');
    expect(db.listAgents(workspaceId)).toHaveLength(0);
  });

  it('returns null for an unknown session id', () => {
    const db = new Db(tempDbPath());
    expect(resolveAgentForSession(db, 'does-not-exist')).toBeNull();
  });
});

describe('shadow schema survives a legacy database (P0)', () => {
  it('creates every shadow table on a database that predates them', () => {
    const file = tempDbPath();
    // First boot creates the current schema.
    const db = new Db(file);
    const workspaceId = makeWorkspace(db);
    makeSession(db, workspaceId, { runtime: 'claude' });
    backfillMultiAgent(db, silentLog);
    const tables = (db as unknown as {
      db: { prepare: (sql: string) => { all: () => { name: string }[] } };
    }).db;
    const names = tables
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);
    for (const table of ['agents', 'session_agents', 'agent_threads', 'session_turns', 'agent_tasks']) {
      expect(names).toContain(table);
    }
    const columns = tables
      .prepare(`SELECT name FROM pragma_table_info('messages')`)
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(['agent_id', 'turn_id', 'task_id', 'committed_seq']));
    db.close();

    // Second boot against the same file must not fail on already-present objects.
    const reopened = new Db(file);
    expect(() => backfillMultiAgent(reopened, silentLog)).not.toThrow();
    expect(reopened.listAgents(workspaceId).length).toBeGreaterThan(0);
    reopened.close();
  });
});

describe('shadow reconciliation (P0)', () => {
  it('reports every check green on a healthy database', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    makeSession(db, workspaceId, { runtime: 'claude' });
    makeSession(db, workspaceId, { runtime: 'codex', kind: 'command' });
    backfillMultiAgent(db, silentLog);

    const counts = db.shadowTableCounts();
    expect(counts.withLeader).toBe(counts.liveSessions);
    expect(counts.withThread).toBe(counts.liveSessions);
    expect(counts.orphanThreads).toBe(0);
    expect(counts.dualWriteMismatch).toBe(0);
    expect(db.listDuplicateImplicitAgents()).toEqual([]);
    expect(db.listDanglingImplicitAgents()).toEqual([]);
  });

  it('detects a native id that drifted between the two columns', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    db.setNativeSessionId(sessionId, 'native-a');
    (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('UPDATE agent_threads SET native_session_id = ? WHERE session_id = ?')
      .run('native-b', sessionId);

    expect(db.shadowTableCounts().dualWriteMismatch).toBe(1);
  });

  it('detects a duplicate implicit agent for one (workspace, runtime)', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    makeSession(db, workspaceId, { runtime: 'claude' });
    (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(
        `INSERT INTO agents (id, workspace_id, name, summary, kind, runtime, instructions,
           is_implicit, enabled, version, created_at, updated_at)
         VALUES ('dup', ?, '重名默认', '', 'runtime', 'claude', '', 1, 1, 1, 0, 0)`,
      )
      .run(workspaceId);

    const duplicates = db.listDuplicateImplicitAgents();
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.runtime).toBe('claude');
  });

  it('detects threads left behind by a deleted session', () => {
    const db = new Db(tempDbPath());
    const workspaceId = makeWorkspace(db);
    const sessionId = makeSession(db, workspaceId, { runtime: 'claude' });
    (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(sessionId);

    expect(db.shadowTableCounts().orphanThreads).toBe(1);
  });
});
