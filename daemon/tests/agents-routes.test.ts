import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureThread, getAgent } from '../src/agents';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { PermissionManager } from '../src/permissions/permissions';
import { registerAgentsRoutes } from '../src/routes/agents';
import { registerChatRoutes } from '../src/routes/chat';
import { RunNotifier } from '../src/runs/run-notifier';
import { SessionNotifier } from '../src/runs/session-notifier';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { defaultCapabilities } from '../src/runtimes/types';

/**
 * HTTP surface for agents and room membership.
 *
 * Two properties get the most attention here: the list DTO never leaks the
 * mechanism fields (they are the owner's business, not an `@` picker's), and a
 * leader cannot be silently removed out from under a session.
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
  starts: RuntimeDriverRequest[];
  base: string;
  workspaceId: string;
  workspacePath: string;
  unavailable: Set<string>;
  request: (method: string, url: string, body?: unknown) => Promise<Response>;
}

async function startApi(): Promise<Harness> {
  const workspacePath = fs.realpathSync(tempDir('paboot-agent-api-'));
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });

  const starts: RuntimeDriverRequest[] = [];
  const unavailable = new Set<string>();
  const makeDriver = (id: string): RuntimeDriver => ({
    id,
    start(req) {
      starts.push(req);
      return {
        id: req.runId,
        promise: Promise.resolve({ status: 'succeeded' as const, exitCode: 0, error: null }),
        cancel: () => {},
      };
    },
  });
  const detection = (id: string) => ({
    id,
    name: id,
    bin: id,
    available: !unavailable.has(id),
    version: 'test',
    authed: true,
    capabilities: { ...defaultCapabilities },
    models: [],
    error: null,
  });
  const registry = {
    driver: (id: string) => (id === 'claude' || id === 'codex' ? makeDriver(id) : undefined),
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
  registerAgentsRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    starts,
    base,
    workspaceId: workspace.id,
    workspacePath,
    unavailable,
    request: (method, url, body) =>
      fetch(`${base}${url}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

describe('agent API', () => {
  it('creates, reads, patches and deletes an agent', async () => {
    const h = await startApi();
    const created = await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
      name: '审阅',
      summary: '代码审查',
      kind: 'runtime',
      runtime: 'claude',
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { id: string; name: string; version: number } };
    expect(agent.name).toBe('审阅');
    expect(agent.version).toBe(1);

    const patched = await h.request('PATCH', `/api/agent-profiles/${agent.id}`, { summary: '只读审查' });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { agent: { summary: string; version: number } };
    expect(after.agent.summary).toBe('只读审查');
    expect(after.agent.version).toBe(2);

    expect((await h.request('DELETE', `/api/agent-profiles/${agent.id}`)).status).toBe(204);
    expect((await h.request('GET', `/api/agent-profiles/${agent.id}`)).status).toBe(404);
  });

  it('reports builtin offline when no provider model is available', async () => {
    const h = await startApi();
    h.unavailable.add('builtin');
    const created = await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
      name: '内置助手',
      kind: 'builtin',
    });
    expect(created.status).toBe(201);
    const list = (await (await h.request('GET', `/api/workspaces/${h.workspaceId}/agents`)).json()) as {
      agents: { name: string; available: boolean; online: boolean }[];
    };
    expect(list.agents.find((agent) => agent.name === '内置助手')).toMatchObject({
      online: false,
      available: false,
    });
  });

  it('reserves @all / @全体 as agent names', async () => {
    const h = await startApi();
    const response = await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
      name: 'all',
      kind: 'builtin',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('reserved_name');
  });

  it('rejects a cwd outside the workspace with a typed error', async () => {
    const h = await startApi();
    const response = await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
      name: 'escape',
      kind: 'builtin',
      cwd: '../../etc',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('cwd_outside_workspace');
  });

  it('never leaks mechanism fields through the list', async () => {
    const h = await startApi();
    await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
      name: 'secretive',
      kind: 'runtime',
      runtime: 'claude',
      readOnly: true,
      permissionCeiling: 'bypass',
    });
    const list = (await (await h.request('GET', `/api/workspaces/${h.workspaceId}/agents`)).json()) as {
      agents: Record<string, unknown>[];
    };
    const row = list.agents.find((item) => item.name === 'secretive')!;
    for (const hidden of ['readOnly', 'permissionCeiling', 'instructions']) {
      expect(row).not.toHaveProperty(hidden);
    }
    // ...but the detail endpoint is the owner's view and does show them.
    const detail = (await (await h.request('GET', `/api/agent-profiles/${row.id as string}`)).json()) as {
      agent: Record<string, unknown>;
    };
    expect(detail.agent.readOnly).toBe(true);
    expect(detail.agent.permissionCeiling).toBe('bypass');
  });

  it('lists only user-authored agents, never the implicit stand-ins', async () => {
    const h = await startApi();
    // Creating a session seeds the runtime's implicit agent.
    h.db.createSession({
      id: 's_implicit',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: h.workspacePath,
    });

    const list = (await (await h.request('GET', `/api/workspaces/${h.workspaceId}/agents`)).json()) as {
      agents: { name: string }[];
    };
    expect(list.agents).toHaveLength(0);

    const all = (await (
      await h.request('GET', `/api/workspaces/${h.workspaceId}/agents?includeImplicit=1`)
    ).json()) as { agents: { name: string }[] };
    expect(all.agents.map((agent) => agent.name)).toEqual(['默认']);
  });

  it('falls back to the name when the summary is empty', async () => {
    const h = await startApi();
    await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
      name: '没有简介',
      kind: 'runtime',
      runtime: 'claude',
    });
    const list = (await (await h.request('GET', `/api/workspaces/${h.workspaceId}/agents`)).json()) as {
      agents: { name: string; summary: string }[];
    };
    const row = list.agents.find((item) => item.name === '没有简介')!;
    expect(row.summary).toBe('没有简介');
  });
});

describe('room membership API', () => {
  async function seedSession(h: Harness): Promise<string> {
    await (await h.request('POST', '/api/chat', { prompt: 'hi' })).text();
    return h.db.listSessions()[0]!.id;
  }

  it('adds a member but never lets the fixed leader be removed', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'mate',
        kind: 'runtime',
        runtime: 'codex',
        // 会话里已经有可写的 leader：新成员必须是只读的（03-room §5.2）。
        readOnly: true,
      })
    ).json()) as { agent: { id: string } };
    const agentId = created.agent.id;

    expect((await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId })).status).toBe(204);

    // The leader is whatever the session was created with; there is no API to
    // hand the room over, so it can never be removed.
    const leaderId = h.db.getSessionLeader(sessionId)!.agent_id;
    expect((await h.request('DELETE', `/api/sessions/${sessionId}/agents/${leaderId}`)).status).toBe(409);
    // A non-leader member can still leave.
    expect((await h.request('DELETE', `/api/sessions/${sessionId}/agents/${agentId}`)).status).toBe(204);
  });

  it('reports whether each member already has a conversation', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const roster = (await (await h.request('GET', `/api/sessions/${sessionId}/agents`)).json()) as {
      leaderId: string | null;
      agents: { id: string; role: string; hasContext: boolean }[];
    };
    expect(roster.leaderId).not.toBeNull();
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]!.role).toBe('leader');
    // No provider reported a conversation for this stub driver.
    expect(roster.agents[0]!.hasContext).toBe(false);
  });

  it('expands one member into its conversation details', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const leaderId = h.db.getSessionLeader(sessionId)!.agent_id;
    const messageId = h.db.addMessage(sessionId, 'assistant', '已完成', {
      agentId: leaderId,
      commit: true,
    });
    const detail = (await (
      await h.request('GET', `/api/sessions/${sessionId}/agents/${leaderId}`)
    ).json()) as {
      agent: { id: string; role: string };
      lastSpoke: { messageId: number; committedSeq: number } | null;
      context: { cwd: string | null; backend: string | null; messageCount: number | null };
    };
    expect(detail.agent).toMatchObject({ id: leaderId, role: 'leader' });
    expect(detail.context.cwd).toBe(h.workspacePath);
    expect(detail.context.backend).toBeTruthy();
    // The newest committed answer, not any later draft.
    expect(detail.lastSpoke).toMatchObject({ messageId });
    // This leader is an external runtime: paboot cannot count its transcript,
    // and must say so instead of inventing a number.
    expect(detail.context.messageCount).toBeNull();
  });

  it('404s when the expanded agent is not a member', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    expect(
      (await h.request('GET', `/api/sessions/${sessionId}/agents/not-a-member`)).status,
    ).toBe(404);
  });

  it('caps a room at eight members and reports the capacity', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);

    const roster = (await (await h.request('GET', `/api/sessions/${sessionId}/agents`)).json()) as {
      agents: unknown[];
      capacity?: { used: number; max: number };
    };
    expect(roster.capacity).toEqual({ used: 1, max: 8 });

    // Only one writable agent per room, so every added member is read-only.
    const add = async (name: string): Promise<Response> => {
      const created = (await (
        await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
          name,
          kind: 'runtime',
          runtime: 'codex',
          readOnly: true,
        })
      ).json()) as { agent: { id: string } };
      return h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId: created.agent.id });
    };

    for (let i = 0; i < 7; i += 1) expect((await add(`mate${i}`)).status).toBe(204);
    const full = await add('overflow');
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'room_full' });

    const after = (await (await h.request('GET', `/api/sessions/${sessionId}/agents`)).json()) as {
      agents: unknown[];
      capacity?: { used: number; max: number };
    };
    expect(after.agents).toHaveLength(8);
    expect(after.capacity).toEqual({ used: 8, max: 8 });
  });

  it('resets one agent conversation without touching the others', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'second',
        kind: 'runtime',
        runtime: 'codex',
        readOnly: true,
      })
    ).json()) as { agent: { id: string } };
    await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId: created.agent.id });
    // A non-leader agent gets a conversation the first time it answers a turn;
    // create that row directly so the reset can be checked against a room with
    // two independent threads. The leader is fixed at session creation.
    const session = h.db.getSession(sessionId)!;
    ensureThread(h.db, session, getAgent(h.db, created.agent.id)!, h.db.getWorkspace(h.workspaceId)!);

    await h.request('POST', `/api/chat`, { prompt: 'again', sessionId });
    const before = h.db.listAgentThreads(sessionId);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const target = h.db.getSessionLeader(sessionId)!.agent_id;
    // The session column mirrors the leader for thread-less callers (notably
    // scheduled runs); a reset must clear both or the old conversation resumes.
    const leaderThread = h.db.getAgentThread(sessionId, target)!;
    h.db.setAgentThreadNativeId(leaderThread.id, 'native-leader');
    expect(h.db.getSession(sessionId)!.native_session_id).toBe('native-leader');

    expect((await h.request('POST', `/api/sessions/${sessionId}/agents/${target}/reset-context`)).status).toBe(204);
    const after = h.db.getAgentThread(sessionId, target)!;
    expect(after.native_session_id).toBeNull();
    expect(after.status).toBe('broken');
    expect(h.db.getSession(sessionId)!.native_session_id).toBeNull();
    // The other agent's conversation is untouched.
    for (const thread of h.db.listAgentThreads(sessionId)) {
      if (thread.agent_id !== target) expect(thread.status).not.toBe('broken');
    }
  });

  it('treats a builtin transcript as context and clears it on reset', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'builtin-review',
        kind: 'builtin',
        readOnly: true,
      })
    ).json()) as { agent: { id: string } };
    const agentId = created.agent.id;
    expect((await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId })).status).toBe(204);

    // Builtin has no provider session id; its context is the native transcript.
    const native = h.db.createNativeThread({ sessionId, agentId });
    h.db.appendNativeMessage({
      threadId: native.id,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    });

    const roster = async (): Promise<{ id: string; hasContext: boolean }[]> =>
      (
        (await (await h.request('GET', `/api/sessions/${sessionId}/agents`)).json()) as {
          agents: { id: string; hasContext: boolean }[];
        }
      ).agents;

    expect((await roster()).find((agent) => agent.id === agentId)?.hasContext).toBe(true);
    expect((await h.request('POST', `/api/sessions/${sessionId}/agents/${agentId}/reset-context`)).status).toBe(204);
    expect((await roster()).find((agent) => agent.id === agentId)?.hasContext).toBe(false);
    expect(h.db.listNativeMessages(native.id)).toHaveLength(0);
  });

  it('refuses to reset an agent while it is still working', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'busy-builtin',
        kind: 'builtin',
        readOnly: true,
      })
    ).json()) as { agent: { id: string } };
    const agentId = created.agent.id;
    await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId });

    const native = h.db.createNativeThread({ sessionId, agentId });
    h.db.appendNativeMessage({
      threadId: native.id,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    });
    h.db.createTurn({ id: 'turn-reset', sessionId, prompt: 'hi', tokenLimit: 0, now: Date.now() });
    h.db.createTask({
      id: 'task-reset',
      sessionId,
      turnId: 'turn-reset',
      agentId,
      source: 'mention',
      prompt: 'hi',
      needsWrite: false,
      snapshotSeq: 0,
      now: Date.now(),
    });

    const res = await h.request(
      'POST',
      `/api/sessions/${sessionId}/agents/${agentId}/reset-context`,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('run_in_progress');
    // The live transcript must survive: the builtin kernel still holds this id.
    expect(h.db.getNativeThreadForSession(sessionId, agentId)).toBeDefined();
    expect(h.db.listNativeMessages(native.id).length).toBeGreaterThan(0);
  });

  it('refuses to reset an agent while its run row is still running', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'running-builtin',
        kind: 'builtin',
        readOnly: true,
      })
    ).json()) as { agent: { id: string } };
    const agentId = created.agent.id;
    await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId });
    h.db.createNativeThread({ sessionId, agentId });
    h.db.createRun({
      id: 'run-reset',
      sessionId,
      runtime: 'builtin',
      model: null,
      prompt: 'hi',
      status: 'running',
      agentId,
    });

    const res = await h.request(
      'POST',
      `/api/sessions/${sessionId}/agents/${agentId}/reset-context`,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('run_in_progress');
  });
});
