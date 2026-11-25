import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptLeader, createAgent, ensureThread, getLeader, listAgents } from '../src/agents';
import { joinPeer as joinRemotePeer, removePeerConnection, startPeerTaskRun } from '../src/peer';
import type { SseFrame } from '../src/types/api';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { requireAuth, requireRolePolicy } from '../src/http/auth';
import { PermissionManager } from '../src/permissions/permissions';
import { guestTokenResolver, registerPeerInfoRoute, registerPeerRoutes } from '../src/routes/peer';
import { registerRoomRoutes } from '../src/routes/room';
import { RunNotifier } from '../src/runs/run-notifier';
import { SessionNotifier } from '../src/runs/session-notifier';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { defaultCapabilities } from '../src/runtimes/types';
import type {
  PeerContractDto,
  PeerExposedAgentDto,
  PeerInfoDto,
  PeerInviteDto,
  PeerSessionDto,
} from '../src/types/api';

const OPERATOR = 'operator-token';
const tempDirs: string[] = [];
const servers: import('node:http').Server[] = [];

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
  base: string;
  agentId: string;
  workspace: ReturnType<Db['createWorkspace']>;
  starts: RuntimeDriverRequest[];
  call: (method: string, url: string, token?: string, body?: unknown) => Promise<Response>;
}

async function startApi(): Promise<Harness> {
  const workspacePath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-peer-api-')));
  tempDirs.push(workspacePath);
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });
  const agent = createAgent(db, workspace, {
    workspaceId: workspace.id,
    name: '审阅',
    summary: '审查代码，不改代码',
    kind: 'builtin',
  });

  const starts: RuntimeDriverRequest[] = [];
  const driver: RuntimeDriver = {
    id: 'builtin',
    start(req) {
      starts.push(req);
      req.onEvent({ type: 'text_delta', delta: '远端回答' });
      return {
        id: req.runId,
        promise: Promise.resolve({ status: 'succeeded' as const, exitCode: 0, error: null }),
        cancel: () => {},
      };
    },
  };
  const detection = {
    id: 'builtin',
    name: 'Builtin',
    bin: 'builtin',
    available: true,
    version: 'test',
    authed: true,
    capabilities: { ...defaultCapabilities },
    models: [],
    error: null,
  };
  const registry = {
    driver: (id: string) => (id === 'builtin' ? driver : undefined),
    detection: () => detection,
    detect: async () => detection,
    list: () => [{ id: 'builtin' }],
  };
  const ctx = {
    db,
    registry,
    permissions: new PermissionManager(1_000, () => {}),
    notifier: new RunNotifier(),
    sessionNotifier: new SessionNotifier(),
    config: {
      token: OPERATOR,
      host: '127.0.0.1',
      port: 4780,
      dataDir: path.join(workspacePath, '.paboot-data'),
      permissionTimeoutMs: 1_000,
      runIdleTimeoutMs: 0,
    },
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerPeerInfoRoute(app, ctx);
  app.use(
    '/api',
    requireAuth(OPERATOR, { maxFailures: 0, guestToken: guestTokenResolver(ctx) }),
  );
  app.use('/api', requireRolePolicy());
  registerPeerRoutes(app, ctx);
  // The read-only guard on `/turns` lives in the room routes; register them so
  // the peer-monitoring test exercises the real endpoint.
  registerRoomRoutes(app, ctx);

  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    base,
    agentId: agent.id,
    workspace,
    starts,
    call: (method, url, token, body) =>
      fetch(`${base}${url}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

async function joinPeer(api: Harness): Promise<{ token: string; peerId: string }> {
  await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
  const invite = (await (
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed/invites`, OPERATOR, {})
  ).json()) as PeerInviteDto;
  const token = new URL(invite.url).searchParams.get('t')!;
  const redeemed = (await (
    await api.call('POST', '/api/peer/redeem', token, { peerId: 'peer-corp' })
  ).json()) as { peerId: string };
  return { token, peerId: redeemed.peerId };
}

describe('peer A-side routes', () => {
  it('shows agents only to the token that names them', async () => {
    const api = await startApi();
    const exposure = await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
    expect(exposure.status).toBe(200);
    const dto = (await exposure.json()) as PeerExposedAgentDto;
    expect(dto.enabled).toBe(true);
    expect(dto.contract.access).toBe('full');
    expect(dto.contract.approvalPolicy).toBe('relay');

    // Anonymous callers learn identity only — no agent enumeration.
    const anon = (await (await api.call('GET', '/api/peer/info')).json()) as PeerInfoDto;
    expect(anon.serverId).toBeTruthy();
    expect(anon.agents).toEqual([]);

    const invite = (await (
      await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed/invites`, OPERATOR, {})
    ).json()) as PeerInviteDto;
    const token = new URL(invite.url).searchParams.get('t')!;
    const scoped = (await (
      await api.call('GET', '/api/peer/info', token)
    ).json()) as PeerInfoDto;
    expect(scoped.agents).toEqual([
      {
        agentId: api.agentId,
        publicName: '审阅',
        summary: '审查代码，不改代码',
        contractVersion: 1,
      },
    ]);
    expect(JSON.stringify(scoped)).not.toContain('dirs');
  });

  it('refuses an invite that targets several agents', async () => {
    const api = await startApi();
    const workspace = api.workspace;
    const other = createAgent(api.db, workspace, {
      workspaceId: workspace.id,
      name: '记录',
      summary: '',
      kind: 'builtin',
    });
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
    const res = await api.call(
      'POST',
      `/api/agent-profiles/${api.agentId}/exposed/invites`,
      OPERATOR,
      { agentIds: [api.agentId, other.id] },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'single_agent_only' });
  });

  it('rejects custom mode with a 400 code', async () => {
    const api = await startApi();
    const res = await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {
      access: 'custom',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'custom_not_supported' });
  });

  it('rejects sharing a Codex agent in v1', async () => {
    const api = await startApi();
    const codex = createAgent(api.db, api.workspace, {
      workspaceId: api.workspace.id,
      name: '代码',
      summary: '',
      kind: 'runtime',
      runtime: 'codex',
    });
    const res = await api.call('POST', `/api/agent-profiles/${codex.id}/exposed`, OPERATOR, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'backend_not_supported' });
  });

  it('keeps a paused share paused when other fields change', async () => {
    const api = await startApi();
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
    const paused = await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {
      enabled: false,
    });
    expect((await paused.json()) as PeerExposedAgentDto).toMatchObject({ enabled: false });

    const edited = await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {
      quota: { runsPerHour: 5 },
    });
    const dto = (await edited.json()) as PeerExposedAgentDto;
    expect(dto.enabled).toBe(false);
    expect(dto.contract.quota.runsPerHour).toBe(5);

    const info = (await (await api.call('GET', '/api/peer/info')).json()) as PeerInfoDto;
    expect(info.agents).toEqual([]);
  });

  it('rejects guest method/path variants outside the allowlist', async () => {
    const api = await startApi();
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
    const invite = (await (
      await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed/invites`, OPERATOR, {})
    ).json()) as PeerInviteDto;
    const token = new URL(invite.url).searchParams.get('t')!;
    await api.call('POST', '/api/peer/redeem', token, { peerId: 'peer-corp' });

    expect((await api.call('DELETE', '/api/peer/agent', token)).status).toBe(403);
    expect((await api.call('GET', '/api/peer/../agents', token)).status).toBe(403);
  });

  it('invite -> guest probe -> redeem -> revoke', async () => {
    const api = await startApi();
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});

    const inviteRes = await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed/invites`, OPERATOR, {});
    expect(inviteRes.status).toBe(200);
    const invite = (await inviteRes.json()) as PeerInviteDto;
    const url = new URL(invite.url);
    expect(url.protocol).toBe('paboot:');
    const token = url.searchParams.get('t');
    expect(token).toBeTruthy();

    // The invite token can probe its own contract before redemption.
    const contractRes = await api.call('GET', `/api/peer/agent?agentId=${api.agentId}`, token!);
    expect(contractRes.status).toBe(200);
    const contract = (await contractRes.json()) as { contract: PeerContractDto };
    expect(contract.contract.publicName).toBe('审阅');

    // A guest cannot touch operator management endpoints.
    const forbidden = await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, token!, {});
    expect(forbidden.status).toBe(403);
    expect((await api.call('POST', '/api/peer/peers', token!, {})).status).toBe(403);
    // ...and an unredeemed invite cannot run anything yet.
    expect((await api.call('POST', '/api/peer/runs', token!, {})).status).toBe(403);

    const redeemed = await api.call('POST', '/api/peer/redeem', token!, { peerId: 'peer-corp' });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({ peerId: 'peer-corp', agentIds: [api.agentId] });

    // Redeeming again is idempotent for the already-issued token.
    const again = await api.call('POST', '/api/peer/redeem', token!, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ peerId: 'peer-corp', agentIds: [api.agentId] });

    // Revoking the only scoped token kills guest access immediately.
    const revoked = await api.call('DELETE', `/api/agent-profiles/${api.agentId}/exposed/tokens`, OPERATOR);
    expect(revoked.status).toBe(200);
    const afterRevoke = await api.call('GET', `/api/peer/agent?agentId=${api.agentId}`, token!);
    expect(afterRevoke.status).toBe(401);

    const info = (await (await api.call('GET', '/api/peer/info')).json()) as PeerInfoDto;
    expect(info.agents).toEqual([]);
  });

  it('runs an agent on a threadKey and replays idempotent retries', async () => {
    const api = await startApi();
    const { token } = await joinPeer(api);
    const body = {
      agentId: api.agentId,
      clientRunId: 'cr-1',
      threadKey: 'tk-1',
      prompt: '帮我看看这个接口设计',
    };

    const first = await api.call('POST', '/api/peer/runs', token, body);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const firstText = await first.text();
    expect(firstText).toContain('"type":"peer_meta"');
    expect(firstText).toContain('远端回答');
    expect(firstText).toContain('"terminal":true');
    expect(api.starts).toHaveLength(1);

    // A network retry must not start a second run.
    const retry = await api.call('POST', '/api/peer/runs', token, body);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('远端回答');
    expect(api.starts).toHaveLength(1);

    // The same threadKey + a new clientRunId resumes the same hidden session.
    const next = await api.call('POST', '/api/peer/runs', token, {
      ...body,
      clientRunId: 'cr-2',
    });
    expect(next.status).toBe(200);
    await next.text();
    expect(api.starts).toHaveLength(2);
    expect(api.starts[1]?.sessionId).toBe(api.starts[0]?.sessionId);

    const run = api.db.getRunByPeerClientRun('peer-corp', 'cr-1');
    expect(run).toBeTruthy();
    const replay = await api.call('GET', `/api/peer/runs/${run!.id}/stream?after=0`, token);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('远端回答');
  });

  it('refuses to join its own daemon', async () => {
    const api = await startApi();
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
    const invite = (await (
      await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed/invites`, OPERATOR, {})
    ).json()) as PeerInviteDto;
    const res = await api.call('POST', '/api/peer/peers', OPERATOR, {
      url: invite.url,
      workspaceId: api.workspace.id,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'self_connection' });
  });

  it('rejects a run without threadKey', async () => {
    const api = await startApi();
    const { token } = await joinPeer(api);
    const res = await api.call('POST', '/api/peer/runs', token, {
      agentId: api.agentId,
      clientRunId: 'cr-x',
      prompt: 'hi',
    });
    expect(res.status).toBe(400);
  });

  it('limits a guest to its scoped agents', async () => {
    const api = await startApi();
    const workspace = api.workspace;
    const other = createAgent(api.db, workspace, {
      workspaceId: workspace.id,
      name: '记录',
      summary: '整理结论',
      kind: 'builtin',
    });
    await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed`, OPERATOR, {});
    await api.call('POST', `/api/agent-profiles/${other.id}/exposed`, OPERATOR, {});
    const invite = (await (
      await api.call('POST', `/api/agent-profiles/${api.agentId}/exposed/invites`, OPERATOR, {})
    ).json()) as PeerInviteDto;
    const token = new URL(invite.url).searchParams.get('t')!;

    expect((await api.call('GET', `/api/peer/agent?agentId=${other.id}`, token)).status).toBe(403);
    expect(listAgents(api.db, workspace.id)).toHaveLength(2);
  });
});

describe('peer end-to-end (A exposes, B runs)', () => {
  it('joins a machine and executes a remote agent in a local run', async () => {
    const a = await startApi();
    await a.call('POST', `/api/agent-profiles/${a.agentId}/exposed`, OPERATOR, {});
    const invite = (await (
      await a.call('POST', `/api/agent-profiles/${a.agentId}/exposed/invites`, OPERATOR, {})
    ).json()) as PeerInviteDto;

    const workspacePath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-peer-b-')));
    tempDirs.push(workspacePath);
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'b', path: workspacePath });
    const ctx = {
      db,
      config: { token: 'b-token', host: '127.0.0.1', port: 4781, dataDir: path.join(workspacePath, '.paboot') },
    } as unknown as AppContext;

    const connection = await joinRemotePeer(ctx, { url: invite.url, workspaceId: workspace.id });
    expect(connection.agents).toHaveLength(1);
    expect(db.listPeers('out')).toHaveLength(1);

    const remote = listAgents(db, workspace.id).find((agent) => agent.kind === 'peer');
    expect(remote).toBeTruthy();
    const session = db.createSession({
      id: 's-b',
      runtime: 'peer',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
      title: 'room',
    });
    const thread = ensureThread(db, session, remote!, workspace);
    db.createTask({
      id: 'task-1',
      sessionId: session.id,
      turnId: 'turn-1',
      agentId: remote!.id,
      source: 'mention',
      prompt: '你好，远端',
      needsWrite: false,
      snapshotSeq: 0,
      now: Date.now(),
    });
    const task = db.getTask('task-1')!; 
    const frames: SseFrame[] = [];
    const handle = startPeerTaskRun(ctx, {
      session,
      workspace,
      task,
      agent: remote!,
      thread,
      sink: { frame: (frame) => frames.push(frame) },
    });
    const outcome = await handle.done;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.replyText).toBe('远端回答');
    expect(frames.some((frame) => frame.event.type === 'text_delta')).toBe(true);

    const messages = db.listMessages(session.id);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '远端回答', source: 'peer' });
    const run = db.getRun(handle.runId)!;
    expect(run.status).toBe('succeeded');
    expect(run.remote_run_id).toBeTruthy();
    expect(thread.remoteThreadKey).toBeNull();
  });
});

describe('per-agent connections', () => {
  it('creates one outbound connection per exposed agent', async () => {
    const a = await startApi();
    const second = createAgent(a.db, a.workspace, {
      workspaceId: a.workspace.id,
      name: '记录',
      summary: '整理结论',
      kind: 'builtin',
    });
    for (const id of [a.agentId, second.id]) {
      const exposed = await a.call('POST', `/api/agent-profiles/${id}/exposed`, OPERATOR, {});
      expect(exposed.status).toBe(200);
    }
    const invites = [];
    for (const id of [a.agentId, second.id]) {
      invites.push(
        (await (
          await a.call('POST', `/api/agent-profiles/${id}/exposed/invites`, OPERATOR, {})
        ).json()) as PeerInviteDto,
      );
    }

    const workspacePath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-peer-b2-')));
    tempDirs.push(workspacePath);
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'b', path: workspacePath });
    const ctx = {
      db,
      config: { token: 'b-token', host: '127.0.0.1', port: 4782 },
    } as unknown as AppContext;

    await joinRemotePeer(ctx, { url: invites[0]!.url, workspaceId: workspace.id });
    // A second invite from the same machine must not replace the first one.
    await joinRemotePeer(ctx, { url: invites[1]!.url, workspaceId: workspace.id });

    const peers = db.listPeers('out');
    expect(peers).toHaveLength(2);
    expect(new Set(peers.map((peer) => peer.id)).size).toBe(2);
    const agents = listAgents(db, workspace.id).filter((agent) => agent.kind === 'peer');
    expect(agents).toHaveLength(2);
    expect(new Set(agents.map((agent) => agent.peerId)).size).toBe(2);
  });
});

describe('disconnecting a peer that leads a 1:1 session', () => {
  it('hands the room to a local assistant before removing the peer', async () => {
    const a = await startApi();
    await a.call('POST', `/api/agent-profiles/${a.agentId}/exposed`, OPERATOR, {});
    const invite = (await (
      await a.call('POST', `/api/agent-profiles/${a.agentId}/exposed/invites`, OPERATOR, {})
    ).json()) as PeerInviteDto;

    const workspacePath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-peer-b3-')));
    tempDirs.push(workspacePath);
    const db = new Db(':memory:');
    const workspace = db.createWorkspace({ name: 'b', path: workspacePath });
    const ctx = {
      db,
      config: { token: 'b-token', host: '127.0.0.1', port: 4783 },
    } as unknown as AppContext;

    await joinRemotePeer(ctx, { url: invite.url, workspaceId: workspace.id });
    const remote = listAgents(db, workspace.id).find((agent) => agent.kind === 'peer')!;
    const session = db.createSession({
      id: 'direct',
      runtime: 'peer',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspacePath,
    });
    adoptLeader(db, { id: session.id, workspaceId: workspace.id }, remote);
    expect(getLeader(db, session.id)?.id).toBe(remote.id);

    removePeerConnection(ctx, remote.peerId!);
    expect(listAgents(db, workspace.id).some((agent) => agent.id === remote.id)).toBe(false);
    const leader = getLeader(db, session.id);
    expect(leader).toBeTruthy();
    expect(leader?.kind).not.toBe('peer');
  });
});

describe('remote sessions the exposing side may watch', () => {
  it('lists peer-driven hidden sessions with who is behind them', async () => {
    const api = await startApi();
    const session = api.db.createSession({
      id: 'ps_watch',
      runtime: 'builtin',
      workspaceId: api.workspace.id,
      permissionMode: 'ask',
      cwd: api.workspace.path,
      title: '共享运行：审阅',
      purpose: 'peer',
    });
    api.db.upsertPeer({
      id: 'peer-guest',
      direction: 'in',
      server_id: 'peer-guest',
      remote_agent_id: api.agentId,
      label: '同事的电脑',
      base_url: '',
      fingerprint: null,
      token_cipher: null,
      last_seen_at: null,
      created_at: Date.now(),
    });
    api.db.insertPeerThread({
      peer_id: 'peer-guest',
      thread_key: 'tk_watch',
      agent_id: api.agentId,
      session_id: session.id,
      created_at: Date.now(),
    });
    api.db.createRun({
      id: 'run-watch',
      sessionId: session.id,
      runtime: 'builtin',
      model: null,
      prompt: '远端在问',
      status: 'running',
      trigger: 'peer',
      permissionMode: 'ask',
      agentId: api.agentId,
    });

    const res = await api.call(
      'GET',
      `/api/peer/sessions?workspaceId=${encodeURIComponent(api.workspace.id)}`,
      OPERATOR,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: PeerSessionDto[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: session.id,
      workspaceId: api.workspace.id,
      title: '共享运行：审阅',
      agentId: api.agentId,
      agentName: '审阅',
      peerId: 'peer-guest',
      peerLabel: '同事的电脑',
      threadKey: 'tk_watch',
      running: true,
      runningRunIds: ['run-watch'],
    });
    // Still hidden from the normal rail.
    expect(api.db.listSessions(api.workspace.id)).toEqual([]);
  });

  it('refuses to inject a turn into a peer-driven session', async () => {
    const api = await startApi();
    api.db.createSession({
      id: 'ps_readonly',
      runtime: 'builtin',
      workspaceId: api.workspace.id,
      permissionMode: 'ask',
      cwd: api.workspace.path,
      purpose: 'peer',
    });

    const res = await api.call('POST', '/api/sessions/ps_readonly/turns', OPERATOR, {
      prompt: '让我也插一句',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'peer_session_read_only' });

    // Pure read-only: the exposing side cannot stop the visitor's run either.
    const cancel = await api.call('POST', '/api/sessions/ps_readonly/cancel', OPERATOR);
    expect(cancel.status).toBe(403);
    expect(await cancel.json()).toMatchObject({ code: 'peer_session_read_only' });
  });
});
