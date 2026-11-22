import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import {
  AgentValidationError,
  addToSession,
  backendFor,
  createAgent,
  ensureThread,
  getLeader,
  listThreads,
  removeAgent,
  resolveSessionAgent,
  sessionRoster,
  updateAgent,
  type Agent,
} from '../src/agents/index';
import { Db, type SessionRow } from '../src/db/db';
import { PermissionManager } from '../src/permissions/permissions';
import { registerChatRoutes } from '../src/routes/chat';
import { startSessionRun } from '../src/runs/run-service';
import { RunNotifier } from '../src/runs/run-notifier';
import { SessionNotifier } from '../src/runs/session-notifier';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { defaultCapabilities } from '../src/runtimes/types';

/**
 * P1 acceptance: an agent is a reusable definition, and a session is a room in
 * which several of them keep *separate* conversations.
 *
 * The property that matters most is isolation: two agents in one session must
 * never see each other's provider conversation, and one agent's directory must
 * not leak into the other's run.
 */

const tempDirs: string[] = [];
const servers: import('node:http').Server[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  db: Db;
  ctx: AppContext;
  starts: RuntimeDriverRequest[];
  workspaceId: string;
  workspacePath: string;
  base: string;
}

async function startApi(): Promise<Harness> {
  const workspacePath = fs.realpathSync(tempDir('paboot-agent-ws-'));
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });

  const starts: RuntimeDriverRequest[] = [];
  const makeDriver = (id: string): RuntimeDriver => ({
    id,
    start(req) {
      starts.push(req);
      // Name the conversation up front, like Claude does, so the thread gets a
      // native id we can assert on.
      req.onNativeSessionId(`${id}-native-${starts.length}`);
      return {
        id: req.runId,
        promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
        cancel: () => {},
      };
    },
  });
  const drivers: Record<string, RuntimeDriver> = {
    claude: makeDriver('claude'),
    codex: makeDriver('codex'),
  };
  const detection = (id: string) => ({
    id,
    name: id,
    bin: id,
    available: true,
    version: 'test',
    authed: true,
    capabilities: { ...defaultCapabilities },
    models: [],
    error: null,
  });
  const registry = {
    driver: (id: string) => drivers[id],
    detection,
    detect: async (id: string) => detection(id),
    list: () => [{ id: 'claude' }, { id: 'codex' }],
  };

  const ctx = {
    db,
    registry,
    permissions: new PermissionManager(1000, () => {}),
    notifier: new RunNotifier(),
    sessionNotifier: new SessionNotifier(),
    config: { permissionMode: 'ask', host: '127.0.0.1', port: 1, runIdleTimeoutMs: 0 },
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerChatRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    db,
    ctx,
    starts,
    workspaceId: workspace.id,
    workspacePath,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function chat(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function workspaceOf(db: Db, id: string) {
  return db.getWorkspace(id)!;
}

/**
 * Run one agent the way a turn task does, without the HTTP surface.
 *
 * A session's leader is fixed when it is created, so a non-leader agent can only
 * speak through a room turn. This calls the same `startSessionRun` seam that
 * path uses, which is what keeps the per-agent behaviour under test.
 */
async function runAgent(
  h: Harness,
  session: SessionRow,
  agent: Agent,
  prompt: string,
  options: { permissionMode?: 'ask' | 'acceptEdits' | 'bypass'; model?: string | null } = {},
): Promise<void> {
  const workspace = workspaceOf(h.db, h.workspaceId);
  const thread = ensureThread(h.db, session, agent, workspace);
  const driver = h.ctx.registry.driver(backendFor(agent));
  if (!driver) throw new Error(`no driver for ${agent.id}`);
  const current = h.db.getSession(session.id) ?? session;
  const handle = startSessionRun(h.ctx, {
    session: current,
    workspace,
    prompt,
    driver,
    permissionMode:
      options.permissionMode ?? (current.permission_mode as 'ask' | 'acceptEdits' | 'bypass'),
    model: options.model ?? null,
    modelParameters: null,
    trigger: 'user',
    sink: { frame() {} },
    agent,
    thread,
  });
  await handle.done;
}

describe('agent definitions', () => {
  it('creates an agent with defaults that fail closed', () => {
    const h = new Db(':memory:');
    const workspace = h.createWorkspace({ name: 'w', path: tempDir('agent-crud-') });
    const agent = createAgent(h, workspace, { workspaceId: workspace.id, name: '审阅', kind: 'builtin' });

    expect(agent.readOnly).toBe(false);
    expect(agent.permissionCeiling).toBe('ask');
    expect(agent.enabled).toBe(true);
    expect(agent.version).toBe(1);
    expect(agent.isImplicit).toBe(false);
    expect(agent.extraDirs).toEqual([]);
    expect(agent.cwd).toBeNull();
  });

  it('refuses a duplicate name regardless of case', () => {
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'w', path: tempDir('agent-name-') });
    createAgent(db, workspace, { workspaceId: workspace.id, name: 'Review', kind: 'builtin' });
    expect(() =>
      createAgent(db, workspace, { workspaceId: workspace.id, name: 'review', kind: 'builtin' }),
    ).toThrowError(/already exists/);
  });

  it('refuses a cwd or extra dir outside the workspace', () => {
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'w', path: tempDir('agent-path-') });
    expect(() =>
      createAgent(db, workspace, {
        workspaceId: workspace.id,
        name: 'escape',
        kind: 'builtin',
        cwd: '../elsewhere',
      }),
    ).toThrowError(AgentValidationError);
    expect(() =>
      createAgent(db, workspace, {
        workspaceId: workspace.id,
        name: 'escape2',
        kind: 'builtin',
        extraDirs: ['/etc'],
      }),
    ).toThrowError(/inside the workspace/);
  });

  it('accepts a subdirectory of the workspace as the working directory', () => {
    const db = new Db(':memory:');
    const workspacePath = fs.realpathSync(tempDir('agent-subdir-'));
    const workspace = db.createWorkspace({ name: 'w', path: workspacePath });
    fs.mkdirSync(path.join(workspacePath, 'docs'));
    const agent = createAgent(db, workspace, {
      workspaceId: workspace.id,
      name: '记录',
      kind: 'builtin',
      cwd: 'docs',
    });
    expect(agent.cwd).toBe(path.join(workspacePath, 'docs'));
  });

  it('bumps the version on every edit and moves existing threads with the cwd', () => {
    const db = new Db(':memory:');
    const workspacePath = fs.realpathSync(tempDir('agent-version-'));
    const workspace = db.createWorkspace({ name: 'w', path: workspacePath });
    fs.mkdirSync(path.join(workspacePath, 'docs'));
    const agent = createAgent(db, workspace, { workspaceId: workspace.id, name: 'a', kind: 'builtin' });
    const session = db.createSession({
      id: 's1',
      runtime: 'builtin',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    addToSession(db, { id: session.id, workspaceId: workspace.id }, agent.id);
    const thread = ensureThread(db, session, agent, workspace);
    expect(thread.cwd).toBe(workspacePath);

    const updated = updateAgent(db, workspace, agent.id, { cwd: 'docs' });
    expect(updated.version).toBe(2);
    // The open conversation follows the agent to its new directory.
    expect(listThreads(db, session.id)[0]!.cwd).toBe(path.join(workspacePath, 'docs'));
  });

  it('rejects removing the fixed leader but lets a member leave', () => {
    const db = new Db(':memory:');
    const workspacePath = fs.realpathSync(tempDir('agent-remove-'));
    const workspace = db.createWorkspace({ name: 'w', path: workspacePath });
    const member = createAgent(db, workspace, { workspaceId: workspace.id, name: 'mate', kind: 'builtin' });
    const session = db.createSession({
      id: 's1',
      runtime: 'builtin',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    addToSession(db, { id: session.id, workspaceId: workspace.id }, member.id);
    // The session was created with this runtime, so its implicit agent owns it.
    const leader = getLeader(db, session.id)!;

    expect(leader.isImplicit).toBe(true);
    expect(() => removeAgent(db, leader.id)).toThrowError(/leader/);

    removeAgent(db, member.id);
    const roster = sessionRoster(db, session.id).map((row) => row.agent.id);
    expect(roster).not.toContain(member.id);
    expect(getLeader(db, session.id)?.id).toBe(leader.id);
  });

  it('requires wiring that matches the kind', () => {
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'w', path: tempDir('agent-wiring-') });
    expect(() =>
      createAgent(db, workspace, { workspaceId: workspace.id, name: 'x', kind: 'runtime' }),
    ).toThrowError(/runtime id/);
    expect(() =>
      createAgent(db, workspace, { workspaceId: workspace.id, name: 'y', kind: 'peer' }),
    ).toThrowError(/peerId/);
  });
});

describe('one session, several agents, separate conversations', () => {
  it('keeps a native id per agent instead of per session', async () => {
    const h = await startApi();
    const workspace = workspaceOf(h.db, h.workspaceId);
    const reader = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '审阅',
      kind: 'runtime',
      runtime: 'claude',
    });
    const writer = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '实现',
      kind: 'runtime',
      runtime: 'codex',
    });

    // First message creates the session; pin both agents into it afterwards.
    await (await chat(h.base, { prompt: 'first', runtime: 'claude' })).text();
    const session = h.db.listSessions()[0]!;
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, reader.id);
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, writer.id);

    await runAgent(h, session, reader, 'ask the reader');
    await runAgent(h, session, writer, 'ask the writer');

    const threads = listThreads(h.db, session.id);
    const readerThread = threads.find((thread) => thread.agentId === reader.id)!;
    const writerThread = threads.find((thread) => thread.agentId === writer.id)!;

    expect(readerThread.backend).toBe('claude');
    expect(writerThread.backend).toBe('codex');
    // Distinct conversations, each on its own backend.
    expect(readerThread.nativeSessionId).not.toBeNull();
    expect(writerThread.nativeSessionId).not.toBeNull();
    expect(readerThread.nativeSessionId).not.toBe(writerThread.nativeSessionId);
  });

  it('resumes the asked agent rather than the session', async () => {
    const h = await startApi();
    const workspace = workspaceOf(h.db, h.workspaceId);
    const first = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: 'first',
      kind: 'runtime',
      runtime: 'claude',
    });
    const second = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: 'second',
      kind: 'runtime',
      runtime: 'codex',
    });

    await (await chat(h.base, { prompt: 'a', runtime: 'claude' })).text();
    const session = h.db.listSessions()[0]!;
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, first.id);
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, second.id);

    await runAgent(h, session, first, 'b');
    expect(h.starts.at(-1)!.resumeNativeSessionId).toBeUndefined(); // first run for this thread

    await runAgent(h, session, second, 'c');
    // The other thread has never spoken: it must not resume the first agent's
    // conversation.
    expect(h.starts.at(-1)!.resumeNativeSessionId).toBeUndefined();

    const writerBefore = listThreads(h.db, session.id).find((thread) => thread.agentId === second.id)!;
    expect(writerBefore.nativeSessionId).not.toBeNull();
    await runAgent(h, session, second, 'd');
    expect(h.starts.at(-1)!.resumeNativeSessionId).toBe(writerBefore.nativeSessionId);
  });

  it('runs each agent in its own directory', async () => {
    const h = await startApi();
    const workspace = workspaceOf(h.db, h.workspaceId);
    fs.mkdirSync(path.join(h.workspacePath, 'docs'));
    const reader = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: 'in-docs',
      kind: 'runtime',
      runtime: 'claude',
      cwd: 'docs',
    });
    const writer = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: 'in-root',
      kind: 'runtime',
      runtime: 'claude',
    });

    await (await chat(h.base, { prompt: 'a' })).text();
    const session = h.db.listSessions()[0]!;
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, reader.id);
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, writer.id);

    await runAgent(h, session, reader, 'b');
    expect(h.starts.at(-1)!.cwd).toBe(path.join(h.workspacePath, 'docs'));

    await runAgent(h, session, writer, 'c');
    expect(h.starts.at(-1)!.cwd).toBe(h.workspacePath);
  });

  it('sends the agent its own model rather than the session default', async () => {
    const h = await startApi();
    const workspace = workspaceOf(h.db, h.workspaceId);
    const agent = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: 'modelled',
      kind: 'runtime',
      runtime: 'claude',
      model: 'claude-sonnet-test',
    });

    await (await chat(h.base, { prompt: 'a', model: 'session-model' })).text();
    const session = h.db.listSessions()[0]!;
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, agent.id);

    await runAgent(h, session, agent, 'b');
    // No request-level model here, so the agent's own choice beats the session's.
    expect(h.starts.at(-1)!.model).toBe('claude-sonnet-test');
  });

  it('keeps the legacy session columns pointing at the leader', async () => {
    const h = await startApi();
    await (await chat(h.base, { prompt: 'a', runtime: 'codex' })).text();
    const session = h.db.listSessions()[0]!;
    const leader = getLeader(h.db, session.id)!;

    await (await chat(h.base, { prompt: 'b', sessionId: session.id })).text();
    const after = h.db.getSession(session.id)!;
    // Old clients read these two columns; they must describe the leader.
    expect(after.runtime).toBe('codex');
    const leaderThread = listThreads(h.db, session.id).find((thread) => thread.agentId === leader.id)!;
    expect(after.native_session_id).toBe(leaderThread.nativeSessionId);
  });
});

describe('resolution behaves like the daemon before agents existed', () => {
  it('runs an agentless session on its own runtime', async () => {
    const h = await startApi();
    await (await chat(h.base, { prompt: 'hi', runtime: 'codex' })).text();
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]!.resumeNativeSessionId).toBeUndefined();
    // The workspace's implicit agent carries the session; no user-facing agent
    // is invented, and the run still lands on the session's own runtime.
    const agents = h.db.listAgents(h.workspaceId);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.is_implicit).toBe(1);
    expect(agents[0]!.runtime).toBe('codex');
  });

  it('reports which fallback answered', () => {
    const db = new Db(':memory:');
    const workspacePath = fs.realpathSync(tempDir('agent-resolve-'));
    const workspace = db.createWorkspace({ name: 'w', path: workspacePath });
    const session = db.createSession({
      id: 's1',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    const resolved = resolveSessionAgent(db, session, workspace);
    // Creating the session seeded the workspace's implicit agent, which adopts
    // the session as leader. An agentless workspace is covered separately by
    // deleting every agent first.
    expect(resolved?.source).toBe('leader');
    expect(resolved!.agent.runtime).toBe('claude');
    expect(resolved!.thread.backend).toBe('claude');
  });
});

describe('agent permission ceiling', () => {
  async function seed(h: Harness, ceiling: 'ask' | 'acceptEdits' | 'bypass') {
    const workspace = workspaceOf(h.db, h.workspaceId);
    const agent = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: `ceil-${ceiling}`,
      kind: 'runtime',
      runtime: 'claude',
      permissionCeiling: ceiling,
    });
    await (await chat(h.base, { prompt: 'a' })).text();
    const session = h.db.listSessions()[0]!;
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, agent.id);
    return { session, agent };
  }

  it('tightens a looser request down to the agent ceiling', async () => {
    const h = await startApi();
    const { session, agent } = await seed(h, 'ask');
    await runAgent(h, session, agent, 'b', { permissionMode: 'bypass' });
    expect(h.starts.at(-1)!.permissionMode).toBe('ask');
  });

  it('does not loosen a stricter request up to the agent ceiling', async () => {
    const h = await startApi();
    const { session, agent } = await seed(h, 'bypass');
    await runAgent(h, session, agent, 'b', { permissionMode: 'ask' });
    expect(h.starts.at(-1)!.permissionMode).toBe('ask');
  });

  it('leaves the implicit agent out of the comparison', async () => {
    const h = await startApi();
    // No explicit agent: the workspace's implicit stand-in must not narrow the
    // request, or every existing session would silently lose its mode.
    await (await chat(h.base, { prompt: 'a', permissionMode: 'acceptEdits' })).text();
    expect(h.starts.at(-1)!.permissionMode).toBe('acceptEdits');
  });
});

describe('builtin transcripts are keyed by agent', () => {
  it('re-keys a pre-agent transcript onto the leader instead of orphaning it', () => {
    const db = new Db(':memory:');
    const workspacePath = fs.realpathSync(tempDir('builtin-rekey-'));
    const workspace = db.createWorkspace({ name: 'w', path: workspacePath });
    const session = db.createSession({
      id: 's1',
      runtime: 'builtin',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    const leader = getLeader(db, session.id)!;
    // Simulate a transcript written before agents existed.
    (db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`INSERT INTO native_threads (id, session_id, agent_id, created_at) VALUES (?, ?, 'builtin', ?)`)
      .run('legacy-thread', session.id, Date.now());

    const moved = db.backfillNativeThreadAgents();
    expect(moved).toBe(1);
    const row = db.getNativeThreadForSession(session.id, leader.id);
    expect(row?.id).toBe('legacy-thread');
    // Idempotent: nothing left to move.
    expect(db.backfillNativeThreadAgents()).toBe(0);
  });

  it('gives two builtin agents their own transcript inside one session', () => {
    const db = new Db(':memory:');
    const workspacePath = fs.realpathSync(tempDir('builtin-split-'));
    const workspace = db.createWorkspace({ name: 'w', path: workspacePath });
    const session = db.createSession({
      id: 's1',
      runtime: 'builtin',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    const a = createAgent(db, workspace, { workspaceId: workspace.id, name: 'A', kind: 'builtin' });
    const b = createAgent(db, workspace, { workspaceId: workspace.id, name: 'B', kind: 'builtin' });
    addToSession(db, { id: session.id, workspaceId: workspace.id }, a.id);
    addToSession(db, { id: session.id, workspaceId: workspace.id }, b.id);

    const threadA = ensureThread(db, session, a, workspace);
    const threadB = ensureThread(db, session, b, workspace);
    expect(threadA.backend).toBe('builtin');
    expect(threadB.backend).toBe('builtin');

    // The builtin runtime resolves its transcript by (session, agent): two
    // distinct ids mean two distinct conversations.
    const resolvedA = db.getNativeThreadForSession(session.id, a.id);
    const resolvedB = db.getNativeThreadForSession(session.id, b.id);
    expect(resolvedA).toBeUndefined();
    expect(resolvedB).toBeUndefined();
    // ...and they are addressed by different keys, which is the whole point.
    expect(threadA.id).not.toBe(threadB.id);
  });
});

describe("a new session's leader follows the runtime the user picked", () => {
  it('binds the workspace agent for that runtime as leader', async () => {
    const h = await startApi();
    const workspace = workspaceOf(h.db, h.workspaceId);
    // A custom agent exists, but the picker chose a runtime — that must win.
    createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: 'unrelated',
      kind: 'runtime',
      runtime: 'claude',
    });

    await (await chat(h.base, { prompt: 'hi', runtime: 'codex' })).text();

    const session = h.db.listSessions()[0]!;
    const leader = getLeader(h.db, session.id)!;
    expect(leader.isImplicit).toBe(true);
    expect(leader.runtime).toBe('codex');
    expect(session.runtime).toBe('codex');
    // The custom claude agent did not hijack the room.
    expect(leader.name).not.toBe('unrelated');
  });

  it('is the single leader even when the workspace has several runtimes', async () => {
    const h = await startApi();
    await (await chat(h.base, { prompt: 'a', runtime: 'claude' })).text();
    await (await chat(h.base, { prompt: 'b', runtime: 'codex' })).text();

    const sessions = h.db.listSessions();
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      const leader = getLeader(h.db, session.id)!;
      expect(leader.runtime).toBe(session.runtime);
    }
  });
});

describe('read-only agents', () => {
  async function seed(h: Harness, runtime: 'claude' | 'codex', mode: 'ask' | 'acceptEdits') {
    const workspace = workspaceOf(h.db, h.workspaceId);
    await (await chat(h.base, { prompt: 'a', runtime })).text();
    const session = h.db.listSessions()[0]!;
    const agent = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: `readonly-${runtime}`,
      kind: 'runtime',
      runtime,
      readOnly: true,
      // Lift the ceiling so this test measures read-only handling, not the
      // default `ask` ceiling.
      permissionCeiling: 'bypass',
    });
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, agent.id);
    h.db.setSessionPermissionMode(session.id, mode);
    return { session, agent };
  }

  it('passes readOnly to the driver', async () => {
    const h = await startApi();
    const { session, agent } = await seed(h, 'claude', 'ask');
    await runAgent(h, session, agent, 'b');
    expect(h.starts.at(-1)!.readOnly).toBe(true);
  });

  it('clamps a backend without a read-only primitive to approval', async () => {
    const h = await startApi();
    const { session, agent } = await seed(h, 'claude', 'acceptEdits');
    await runAgent(h, session, agent, 'b');
    expect(h.starts.at(-1)!.permissionMode).toBe('ask');
  });

  it('leaves Codex on its own mode because its sandbox enforces it', async () => {
    const h = await startApi();
    const { session, agent } = await seed(h, 'codex', 'acceptEdits');
    await runAgent(h, session, agent, 'b');
    expect(h.starts.at(-1)!.permissionMode).toBe('acceptEdits');
    expect(h.starts.at(-1)!.readOnly).toBe(true);
  });
});
