import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db/db';
import type { AppContext } from '../src/app/context';
import { PermissionManager } from '../src/permissions/permissions';
import { RunNotifier } from '../src/runs/run-notifier';
import { registerRuntimeDrivers } from '../src/runtimes/drivers';
import { createRegistry } from '../src/runtimes/registry';
import { defaultCapabilities } from '../src/runtimes/types';
import { getActiveRun, listActiveRuns } from '../src/runtimes/active-runs';
import { registerChatRoutes } from '../src/routes/chat';
import { registerRunRoutes } from '../src/routes/runs';
import { registerSessionRoutes } from '../src/routes/sessions';
import { registerPermissionRoutes } from '../src/routes/permissions';
import { registerAgentRoutes } from '../src/routes/agent';

// Mock only the provider transport. Exercise real sessions, DB, SSE, routes,
// permission decisions and the shared lifecycle without making model requests.
// `hold` makes a method hang, so a test can cancel while that RPC is in flight;
// `close` then rejects it, exactly as `CodexAppServerConnection.close` does.
const { peers, hold } = vi.hoisted(() => ({ peers: [] as any[], hold: new Set<string>() }));
vi.mock('../src/runtimes/codex/rpc', () => ({
  initializeCodexAppServer: async () => ({}),
  spawnCodexAppServer: () => {
    const inFlight: Array<(error: Error) => void> = [];
    const peer = {
      notification: (_method: string, _params: unknown) => {},
      serverRequest: async (_method: string, _params: unknown): Promise<unknown> => ({}),
      exit: (_reason: Error) => {},
      stderr: (_line: string) => {},
      onNotification(fn: typeof peer.notification) { this.notification = fn; },
      onServerRequest(fn: typeof peer.serverRequest) { this.serverRequest = fn; },
      onExit(fn: typeof peer.exit) { this.exit = fn; },
      onStderr(fn: typeof peer.stderr) { this.stderr = fn; },
      request: vi.fn((method: string, params: any) => {
        if (hold.has(method)) return new Promise((_resolve, reject) => { inFlight.push(reject); });
        if (method === 'thread/start') return Promise.resolve({ thread: { id: 'codex-thread-1' } });
        if (method === 'thread/resume') return Promise.resolve({ thread: { id: params.threadId } });
        return Promise.resolve({ turn: { id: 'codex-turn-1' } });
      }),
      close: vi.fn(async () => {
        for (const reject of inFlight.splice(0)) reject(new Error('codex app-server connection closed'));
        // The real child's `exit` lands at least a macrotask after `close()`
        // rejects what was in flight — keep that ordering, or a cancel mid-RPC
        // would look settled before the rejection it actually produces.
        await new Promise((resolve) => setImmediate(resolve));
        peer.exit(new Error('closed'));
      }),
    };
    peers.push(peer);
    return peer;
  },
}));

const servers: Server[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  const runs = listActiveRuns();
  for (const run of runs) run.cancel();
  await Promise.all(runs.map(run => run.promise));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  peers.length = 0;
  hold.clear();
});

async function api(config: Record<string, unknown> = {}) {
  const db = new Db(':memory:');
  dbs.push(db);
  db.seedDefaultWorkspace(process.cwd(), 'ask');
  const registry = createRegistry();
  registry.detect = vi.fn(async (id: string) => ({
    id, name: id, bin: id, available: true, version: 'test', authed: true,
    capabilities: defaultCapabilities, models: [], error: null,
  }));
  const ctx = {
    db, registry, permissions: new PermissionManager(), notifier: new RunNotifier(),
    config: { permissionMode: 'default', host: '127.0.0.1', port: 1, runIdleTimeoutMs: 0, ...config },
  } as unknown as AppContext;
  registerRuntimeDrivers(registry, ctx);
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerPermissionRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown = {}) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ctx, db, base, post };
}

async function startedPeer(index = 0) {
  await vi.waitFor(() => expect(peers[index]?.request).toHaveBeenCalledWith('turn/start', expect.anything()));
  return peers[index];
}
function complete(peer: any) {
  peer.notification('turn/completed', { turn: { status: 'completed' } });
}

describe('Codex HTTP integration', () => {
  it.each(['ask', 'acceptEdits', 'bypass'])('refreshes workspace grants on new and resumed %s runs', async permissionMode => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'paboot-codex-grant-')));
    try {
      const { db, post } = await api();
      const workspace = db.getDefaultWorkspace()!;
      db.addWorkspaceDir(workspace.id, dir);
      db.addWorkspaceDir(workspace.id, join(dir, 'missing'));
      const first = await post('/api/chat', { prompt: 'first', runtime: 'codex', permissionMode });
      const peer = await startedPeer();
      expect(peer.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
        sandboxPolicy: permissionMode === 'bypass'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [workspace.path, dir], networkAccess: false },
        // Without this Codex reports empty summaries and the phone shows no
        // thinking card at all.
        summary: 'concise',
      }));
      complete(peer);
      await first.text();
      db.removeWorkspaceDir(workspace.id, dir);
      const second = await post('/api/chat', { prompt: 'second', sessionId: db.listSessions()[0].id });
      const resumed = await startedPeer(1);
      expect(resumed.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
        sandboxPolicy: permissionMode === 'bypass'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [workspace.path], networkAccess: false },
      }));
      complete(resumed);
      await second.text();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the model reasoning effort to turn/start', async () => {
    const { post } = await api();
    const chat = await post('/api/chat', {
      prompt: 'first',
      runtime: 'codex',
      modelParameters: { reasoningEffort: 'high' },
    });
    const peer = await startedPeer();
    expect(peer.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ effort: 'high' }));
    complete(peer);
    await chat.text();
  });

  it('persists the complete run usage across model calls and excludes earlier turns on resume', async () => {
    const { db, post } = await api();
    const first = await post('/api/chat', { prompt: 'first', runtime: 'codex' });
    const peer = await startedPeer();
    const notify = (target: any, totalInput: number, totalOutput: number, lastInput: number, lastOutput: number) =>
      target.notification('thread/tokenUsage/updated', { tokenUsage: {
        total: { inputTokens: totalInput, outputTokens: totalOutput },
        last: { inputTokens: lastInput, outputTokens: lastOutput },
      } });
    notify(peer, 100, 20, 100, 20);
    notify(peer, 250, 50, 150, 30);
    complete(peer);
    await first.text();
    const session = db.listSessions()[0];
    const second = await post('/api/chat', { prompt: 'second', sessionId: session.id });
    const resumed = await startedPeer(1);
    notify(resumed, 350, 60, 100, 10);
    notify(resumed, 550, 90, 200, 30);
    complete(resumed);
    await second.text();
    const totals = Object.fromEntries(db.listRuns(session.id).map(run => {
      const usages = db.listEvents(run.id).map(row => JSON.parse(row.payload)).filter(ev => ev.type === 'usage');
      return [run.prompt, usages.at(-1).usage];
    }));
    expect(totals).toEqual({
      first: { input_tokens: 250, output_tokens: 50 },
      second: { input_tokens: 300, output_tokens: 40 },
    });
  });

  it('persists context occupancy beside the run total, so a replay can restore it', async () => {
    const { db, post, base } = await api();
    const chat = await post('/api/chat', { prompt: 'occupancy', runtime: 'codex' });
    const peer = await startedPeer();
    const run = db.listRuns(db.listSessions()[0].id)[0];
    peer.notification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 45_200, outputTokens: 900 },
        last: { inputTokens: 45_200, outputTokens: 900 },
        modelContextWindow: 168_000,
      },
    });
    complete(peer);
    await chat.text();

    // Opening a session replays from this table, so the fields have to survive
    // the DB round trip, not just the live stream.
    const { events } = await (await fetch(`${base}/api/runs/${run.id}/events`)).json();
    const usages = events.map((e: { event: { type: string } }) => e.event).filter((e: { type: string }) => e.type === 'usage');
    expect(usages.at(-1)).toMatchObject({
      usage: { input_tokens: 45_200, output_tokens: 900 },
      contextTokens: 45_200,
      contextWindow: 168_000,
    });
  });

  it('advertises Codex to the mobile runtime picker, with availability', async () => {
    const { base } = await api();
    const body = await (await fetch(base + '/api/agents')).json();
    // `available` comes from probing the host, so only its presence and type are
    // stable here — asserting a value would make this fail on a machine without
    // the binary installed.
    expect(body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'codex',
          name: 'Codex',
          bin: 'codex',
          available: expect.any(Boolean),
        }),
      ]),
    );
  });

  it('lists, reconnects and cancels an active Codex run through the public API', async () => {
    const { base, post, db, ctx } = await api();
    const response = await post('/api/chat', { prompt: 'hi', runtime: 'codex' });
    const peer = await startedPeer();
    const session = db.listSessions()[0];
    const run = db.listRuns(session.id)[0];
    expect(getActiveRun(run.id)).toBeDefined();
    const listed = await (await fetch(base + '/api/runs')).json();
    expect(listed.runs[0].id).toBe(run.id);
    const detail = await (await fetch(base + `/api/sessions/${session.id}`)).json();
    expect(detail.session.runningRunId).toBe(run.id);
    await response.body!.cancel();
    const replay = await fetch(base + `/api/runs/${run.id}/stream`);
    const text = replay.text();
    await vi.waitFor(() => expect(ctx.notifier.subscriberCount(run.id)).toBe(1));
    peer.notification('item/agentMessage/delta', { itemId: 'text-1', delta: 'after reconnect' });
    expect((await post(`/api/runs/${run.id}/cancel`)).status).toBe(200);
    expect(await text).toContain('after reconnect');
    await vi.waitFor(() => expect(db.getRun(run.id)?.status).toBe('cancelled'));
    expect(getActiveRun(run.id)).toBeUndefined();
    expect(peer.request).toHaveBeenCalledWith('turn/interrupt', expect.anything(), 5_000);
  });

  it('surfaces Codex stderr problems instead of leaving the operator with silence', async () => {
    const { post, db } = await api();
    const response = await post('/api/chat', { prompt: 'hi', runtime: 'codex' });
    const peer = await startedPeer();
    const run = db.listRuns(db.listSessions()[0].id)[0];

    const line = '2026-10-07T07:34:51.417302Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out';
    peer.stderr(line);
    peer.stderr(line); // same problem twice -> one notice
    peer.stderr('2026-10-07T07:34:46.413083Z  INFO codex_app_server: starting up'); // not a problem

    const notices = db.listEvents(run.id)
      .map((row) => JSON.parse(row.payload))
      .filter((ev) => ev.type === 'error');
    expect(notices).toHaveLength(1);
    // Non-terminal: codex is usually retrying underneath, so this informs
    // without ending the run.
    expect(notices[0]).toMatchObject({ type: 'error', code: 'codex_stderr', terminal: false });
    expect(notices[0].message).toBe(
      'Codex：ERROR codex_models_manager::manager: failed to refresh available models: request timed out',
    );
    expect(db.getRun(run.id)?.status).toBe('running');

    complete(peer);
    await response.text();
  });

  it('cancels a Codex run that goes silent past the idle watchdog', async () => {
    const { db, post } = await api({ runIdleTimeoutMs: 1_000 });
    const response = await post('/api/chat', { prompt: 'stall', runtime: 'codex' });
    const peer = await startedPeer();
    const run = db.listRuns(db.listSessions()[0].id)[0];
    // A mocked peer never reports a turn, which is exactly the wedged-app-server
    // case the watchdog exists for: without it the run would stay `running`.
    await vi.waitFor(() => expect(db.getRun(run.id)?.status).toBe('cancelled'), { timeout: 5_000 });
    expect(db.getRun(run.id)?.error).toBe('idle timeout');
    expect(getActiveRun(run.id)).toBeUndefined();
    expect(peer.request).toHaveBeenCalledWith('turn/interrupt', expect.anything(), 5_000);
    await response.text();
  });

  it('records a cancel that lands mid-handshake as cancelled, not failed', async () => {
    hold.add('thread/start'); // the handshake never finishes on its own
    const { db, post, base } = await api();
    const response = await post('/api/chat', { prompt: 'hi', runtime: 'codex' });
    const run = db.listRuns(db.listSessions()[0].id)[0];
    expect((await post(`/api/runs/${run.id}/cancel`)).status).toBe(200);
    await response.text();
    // `close()` rejects the in-flight handshake RPC; that rejection must surface
    // as the cancel it was, not as a crashed run with an opaque transport error.
    expect(db.getRun(run.id)?.status).toBe('cancelled');
    expect(db.getRun(run.id)?.error).toBe('cancelled by request');
    const { events } = await (await fetch(`${base}/api/runs/${run.id}/events`)).json();
    expect(events.some((e: { event: { type: string } }) => e.event.type === 'error')).toBe(false);
    expect(events.at(-1).event).toMatchObject({ type: 'status', label: 'cancelled', terminal: true });
  });

  it('resumes the saved Codex runtime without a runtime field and rejects a mismatch', async () => {
    const { post, db, ctx } = await api();
    const first = await post('/api/chat', { prompt: 'first', runtime: 'codex' });
    const peer = await startedPeer();
    complete(peer);
    await first.text();
    const session = db.listSessions()[0];
    expect(session.native_session_id).toBe('codex-thread-1');
    const second = await post('/api/chat', { prompt: 'second', sessionId: session.id });
    const resumed = await startedPeer(1);
    expect(resumed.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'codex-thread-1' }));
    expect(ctx.registry.detect).not.toHaveBeenCalledWith('claude', expect.anything());
    complete(resumed);
    await second.text();
    expect((await post('/api/chat', { prompt: 'wrong', sessionId: session.id, runtime: 'claude' })).status).toBe(400);
    expect(db.listRuns(session.id)).toHaveLength(2);
  });

  it.each(['allow', 'deny', 'allow_all'])('encodes a structured permission %s response', async decision => {
    const { post, db } = await api();
    const response = await post('/api/chat', { prompt: 'permissions', runtime: 'codex' });
    const peer = await startedPeer();
    const session = db.listSessions()[0];
    const run = db.listRuns(session.id)[0];
    const permissions = { network: { enabled: true }, fileSystem: { write: ['/tmp/granted'] } };
    const result = peer.serverRequest('item/permissions/requestApproval', { itemId: 'permission-1', permissions });
    const request = db.listEvents(run.id).map(row => JSON.parse(row.payload)).find(ev => ev.type === 'permission_request');
    expect((await post(`/api/permissions/${request.permissionId}/decision`, { decision })).status).toBe(200);
    expect(await result).toEqual({ permissions: decision === 'deny' ? {} : permissions, scope: decision === 'allow_all' ? 'session' : 'turn' });
    complete(peer);
    await response.text();
  });

  it('never auto-answers a Codex user question, and validates the answer it gets', async () => {
    const { post, db } = await api();
    const response = await post('/api/chat', { prompt: 'ask me', runtime: 'codex' });
    const peer = await startedPeer();
    const run = db.listRuns(db.listSessions()[0].id)[0];
    const questions = [{ id: 'q1', header: 'Deploy', question: 'Deploy to prod?', options: [{ label: 'yes', description: '' }] }];
    const answered = peer.serverRequest('item/tool/requestUserInput', { itemId: 'q-1', isBlocking: true, questions });
    const request = db.listEvents(run.id).map(row => JSON.parse(row.payload)).find(ev => ev.type === 'permission_request');
    expect(request.toolName).toBe('UserInput');

    // A question has no answer to remember, so "allow all" must not silently
    // approve later ones — and the request must stay pending for a real answer.
    const all = await post(`/api/permissions/${request.permissionId}/decision`, { decision: 'allow_all' });
    expect(all.status).toBe(400);
    expect((await all.json()).code).toBe('bad_decision');

    const empty = await post(`/api/permissions/${request.permissionId}/decision`, {
      decision: 'allow', response: { answers: {} },
    });
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe('bad_response');

    const ok = await post(`/api/permissions/${request.permissionId}/decision`, {
      decision: 'allow', response: { answers: { q1: { answers: ['yes'] } } },
    });
    expect(ok.status).toBe(200);
    expect(await answered).toEqual({ answers: { q1: { answers: ['yes'] } } });
    complete(peer);
    await response.text();
  });

  it('attaches proposed multi-file diffs to the matching approval', async () => {
    const { post, db } = await api();
    const response = await post('/api/chat', { prompt: 'edit', runtime: 'codex' });
    const peer = await startedPeer();
    const session = db.listSessions()[0];
    const run = db.listRuns(session.id)[0];
    const changes = [
      { path: '/project/a.ts', kind: { type: 'update', move_path: null }, diff: '-old\n+new' },
      { path: '/project/b.ts', kind: { type: 'add' }, diff: '+created' },
    ];
    peer.notification('item/started', { item: { id: 'edit-1', type: 'fileChange', changes } });
    const result = peer.serverRequest('item/fileChange/requestApproval', { itemId: 'edit-1', reason: 'edit two files' });
    const request = db.listEvents(run.id).map(row => JSON.parse(row.payload)).find(ev => ev.type === 'permission_request');
    expect(request.toolInput.changes).toEqual(changes);
    await post(`/api/permissions/${request.permissionId}/decision`, { decision: 'allow' });
    expect(await result).toEqual({ decision: 'accept' });
    complete(peer);
    await response.text();
  });
});
