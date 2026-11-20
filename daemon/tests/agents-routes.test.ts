import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
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
  request: (method: string, url: string, body?: unknown) => Promise<Response>;
}

async function startApi(): Promise<Harness> {
  const workspacePath = fs.realpathSync(tempDir('paboot-agent-api-'));
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });

  const starts: RuntimeDriverRequest[] = [];
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
    available: true,
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

    const patched = await h.request('PATCH', `/api/agents/${agent.id}`, { summary: '只读审查' });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { agent: { summary: string; version: number } };
    expect(after.agent.summary).toBe('只读审查');
    expect(after.agent.version).toBe(2);

    expect((await h.request('DELETE', `/api/agents/${agent.id}`)).status).toBe(204);
    expect((await h.request('GET', `/api/agents/${agent.id}`)).status).toBe(404);
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
      toolsAllow: ['Read'],
    });
    const list = (await (await h.request('GET', `/api/workspaces/${h.workspaceId}/agents`)).json()) as {
      agents: Record<string, unknown>[];
    };
    const row = list.agents.find((item) => item.name === 'secretive')!;
    for (const hidden of ['readOnly', 'permissionCeiling', 'toolsAllow', 'toolsDeny', 'instructions']) {
      expect(row).not.toHaveProperty(hidden);
    }
    // ...but the detail endpoint is the owner's view and does show them.
    const detail = (await (await h.request('GET', `/api/agents/${row.id as string}`)).json()) as {
      agent: Record<string, unknown>;
    };
    expect(detail.agent.readOnly).toBe(true);
    expect(detail.agent.permissionCeiling).toBe('bypass');
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

  it('adds a member, switches the leader, and refuses to drop the leader', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'mate',
        kind: 'runtime',
        runtime: 'codex',
      })
    ).json()) as { agent: { id: string } };
    const agentId = created.agent.id;

    expect((await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId })).status).toBe(204);

    const leader = await h.request('PATCH', `/api/sessions/${sessionId}/leader`, { agentId });
    expect(leader.status).toBe(204);
    expect(h.db.getSessionLeader(sessionId)?.agent_id).toBe(agentId);
    // The legacy mirror follows the leader.
    expect(h.db.getSession(sessionId)!.runtime).toBe('codex');

    expect((await h.request('DELETE', `/api/sessions/${sessionId}/agents/${agentId}`)).status).toBe(409);
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

  it('resets one agent conversation without touching the others', async () => {
    const h = await startApi();
    const sessionId = await seedSession(h);
    const created = (await (
      await h.request('POST', `/api/workspaces/${h.workspaceId}/agents`, {
        name: 'second',
        kind: 'runtime',
        runtime: 'codex',
      })
    ).json()) as { agent: { id: string } };
    await h.request('POST', `/api/sessions/${sessionId}/agents`, { agentId: created.agent.id });
    await h.request('PATCH', `/api/sessions/${sessionId}/leader`, { agentId: created.agent.id });
    // Give both agents a conversation handle.
    const implicit = h.db.getSession(sessionId)!.native_session_id;
    await h.request('POST', `/api/chat`, { prompt: 'again', sessionId });
    const before = h.db.listAgentThreads(sessionId);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const target = h.db.getSessionLeader(sessionId)!.agent_id;
    expect((await h.request('POST', `/api/sessions/${sessionId}/agents/${target}/reset-context`)).status).toBe(204);
    const after = h.db.getAgentThread(sessionId, target)!;
    expect(after.native_session_id).toBeNull();
    expect(after.status).toBe('broken');
    // The other agent's conversation is untouched.
    for (const thread of h.db.listAgentThreads(sessionId)) {
      if (thread.agent_id !== target) expect(thread.status).not.toBe('broken');
    }
    expect(implicit).toBeDefined();
  });
});
