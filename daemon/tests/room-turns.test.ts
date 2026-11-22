import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { addToSession, createAgent, getLeader, updateAgent } from '../src/agents/index';
import { AttachmentStore } from '../src/attachments/store';
import { Db } from '../src/db/db';
import { PermissionManager } from '../src/permissions/permissions';
import { registerAgentsRoutes } from '../src/routes/agents';
import { registerRoomRoutes } from '../src/routes/room';
import { RunNotifier } from '../src/runs/run-notifier';
import { SessionNotifier } from '../src/runs/session-notifier';
import type { RuntimeDriver, RuntimeDriverRequest } from '../src/runtimes/RuntimeDriver';
import { defaultCapabilities } from '../src/runtimes/types';

/**
 * The room: one input, several agents, one shared timeline.
 *
 * What is being pinned down here is the shape of the contract, not the wording of
 * any single answer:
 *   - a turn acknowledges immediately (202) and the answers arrive on the room
 *     stream, because a turn is a batch and not a barrier;
 *   - every answer lands on one timeline in commit order, labelled with its agent;
 *   - one agent failing does not cancel its siblings.
 */

const tempDirs: string[] = [];
const servers: import('node:http').Server[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Minimal structurally valid PNG header carrying exact dimensions. */
function pngBytes(width = 3, height = 2): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
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
  attachments: AttachmentStore;
  starts: RuntimeDriverRequest[];
  base: string;
  workspaceId: string;
  workspacePath: string;
  /** Reply text the stub driver produces, keyed by runtime id. */
  replies: Map<string, string>;
  failures: Set<string>;
  /** Runtime ids whose detection advertises image input. */
  imageCapable: Set<string>;
  request: (method: string, url: string, body?: unknown) => Promise<Response>;
}

async function startApi(): Promise<Harness> {
  const workspacePath = fs.realpathSync(tempDir('paboot-room-'));
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });

  const attachments = new AttachmentStore(db, tempDir('paboot-room-attachments-'));
  const starts: RuntimeDriverRequest[] = [];
  const replies = new Map<string, string>();
  const failures = new Set<string>();
  const imageCapable = new Set(['claude', 'codex']);

  const makeDriver = (id: string): RuntimeDriver => ({
    id,
    start(req) {
      starts.push(req);
      const fail = failures.has(id);
      // Report a native id like Claude does, then finish. A visible answer is
      // emitted so the task→message attribution path is exercised.
      req.onNativeSessionId(`${id}-s${starts.length}`);
      req.onEvent({ type: 'text_delta', delta: replies.get(id) ?? `${id} 回答` });
      return {
        id: req.runId,
        promise: Promise.resolve(
          fail
            ? { status: 'failed' as const, exitCode: 1, error: 'boom' }
            : { status: 'succeeded' as const, exitCode: 0, error: null },
        ),
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
    capabilities: { ...defaultCapabilities, imageInput: imageCapable.has(id) },
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
    attachments,
    registry,
    permissions: new PermissionManager(1000, () => {}),
    notifier: new RunNotifier(),
    sessionNotifier: new SessionNotifier(),
    config: { permissionMode: 'ask', host: '127.0.0.1', port: 1, runIdleTimeoutMs: 0 },
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerRoomRoutes(app, ctx);
  registerAgentsRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    attachments,
    starts,
    base,
    workspaceId: workspace.id,
    workspacePath,
    replies,
    failures,
    imageCapable,
    request: (method, url, body) =>
      fetch(`${base}${url}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

/** A session with a leader plus N read-only members. */
function seedRoom(h: Harness, extra: string[]): string {
  const workspace = h.db.getWorkspace(h.workspaceId)!;
  const session = h.db.createSession({
    id: 's1',
    runtime: 'claude',
    workspaceId: h.workspaceId,
    permissionMode: 'ask',
    cwd: h.workspacePath,
  });
  for (const name of extra) {
    const agent = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name,
      kind: 'runtime',
      runtime: 'codex',
      // Only one writer per room (03-room §5.2); the leader already is one.
      readOnly: true,
    });
    addToSession(h.db, { id: session.id, workspaceId: h.workspaceId }, agent.id);
  }
  return session.id;
}

async function turns(h: Harness, sessionId: string, body: Record<string, unknown>): Promise<Response> {
  return h.request('POST', `/api/sessions/${sessionId}/turns`, body);
}

describe('POST /api/sessions/:id/turns', () => {
  it('acknowledges with 202 and the tasks it started', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);

    const response = await turns(h, sessionId, { prompt: '你好' });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      turnId: string;
      addressed: { agentId: string; source: string }[];
      tasks: { agentId: string; source: string }[];
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.source).toBe('leader_default');
    expect(body.addressed[0]!.agentId).toBe(getLeader(h.db, sessionId)!.id);
  });

  it('starts one task per addressed agent', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;

    const response = await turns(h, sessionId, { prompt: '都看看', mentions: [review.agent_id] });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { tasks: { agentId: string }[] };
    expect(body.tasks.map((task) => task.agentId)).toEqual([review.agent_id]);
  });

  it('commits the user message before any task runs', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    await turns(h, sessionId, { prompt: '先说这句' });

    const committed = h.db.listCommittedMessages(sessionId);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.role).toBe('user');
    expect(committed[0]!.content).toBe('先说这句');
    expect(committed[0]!.agent_id).toBeNull();
  });

  it('admits a workspace agent the user @s, upgrading the session to a room', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const recorder = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '记录',
      kind: 'runtime',
      runtime: 'codex',
      readOnly: true,
    });
    expect(h.db.listSessionAgents(sessionId).some((row) => row.agent_id === recorder.id)).toBe(false);

    const response = await turns(h, sessionId, { prompt: '记一下', mentions: [recorder.id] });
    expect(response.status).toBe(202);
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    // The picker is workspace-level: addressing someone outside the room joins
    // them first, then routes the task to them.
    expect(h.db.listSessionAgents(sessionId).some((row) => row.agent_id === recorder.id)).toBe(
      true,
    );
    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agent_id).toBe(recorder.id);
    expect(tasks[0]!.source).toBe('mention');
  });

  it('refuses to admit a second writable agent', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const writer = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '另一个写者',
      kind: 'runtime',
      runtime: 'codex',
      readOnly: false,
    });

    const response = await turns(h, sessionId, { prompt: '你来写', mentions: [writer.id] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('writable_agent_exists');
    expect(h.db.listSessionAgents(sessionId).some((row) => row.agent_id === writer.id)).toBe(
      false,
    );
  });

  it('refuses a message that addresses nobody usable', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const response = await turns(h, sessionId, { prompt: '喂', mentions: ['ag_nope'] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('no_available_agent');
  });

  it('requires a prompt', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    expect((await turns(h, sessionId, { prompt: '   ' })).status).toBe(400);
  });

  it('rejects more than the addressable mention cap before changing membership', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const response = await turns(h, sessionId, {
      prompt: '太多人',
      mentions: Array.from({ length: 9 }, (_, i) => `ag_${i}`),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('too_many_mentions');
    expect(h.db.listSessionAgents(sessionId)).toHaveLength(1);
  });

  it('404s for an unknown session', async () => {
    const h = await startApi();
    expect((await turns(h, 'nope', { prompt: 'hi' })).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/cancel', () => {
  it('cancels queued room tasks that have not acquired a run yet', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const leader = getLeader(h.db, sessionId)!;
    h.db.createTurn({
      id: 'turn-manual',
      sessionId,
      prompt: '排队',
      tokenLimit: 0,
      now: Date.now(),
    });
    h.db.createTask({
      id: 'task-manual',
      sessionId,
      turnId: 'turn-manual',
      agentId: leader.id,
      source: 'leader_default',
      prompt: '排队',
      needsWrite: false,
      snapshotSeq: 0,
      now: Date.now(),
    });

    const response = await h.request('POST', `/api/sessions/${sessionId}/cancel`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, cancelled: 1 });
    expect(h.db.getTask('task-manual')!.status).toBe('cancelled');
    expect(h.db.getTurn('turn-manual')!.status).toBe('done');
  });

  it('404s for an unknown session', async () => {
    const h = await startApi();
    expect((await h.request('POST', '/api/sessions/nope/cancel')).status).toBe(404);
  });
});


describe('room attachments', () => {
  it('shares one turn attachment with every addressed agent and run', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;
    const attachment = await h.attachments.saveImage(pngBytes(), 'image/png');

    const response = await turns(h, sessionId, {
      prompt: '一起看这张图',
      mentions: [leader.id, review.agent_id],
      attachmentIds: [attachment.id],
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { turnId: string; tasks: { id: string }[] };
    expect(body.tasks).toHaveLength(2);

    await waitFor(() =>
      h.db.listTasksByTurn(body.turnId).every((task) => task.status === 'done'),
    );

    // One user message, one turn-owned attachment list, and one copy of the
    // image for each agent's own provider conversation.
    expect(h.db.listMessages(sessionId).filter((row) => row.role === 'user')).toHaveLength(1);
    expect(h.db.getTurnAttachmentIds(body.turnId)).toEqual([attachment.id]);
    expect(h.starts).toHaveLength(2);
    for (const start of h.starts) {
      expect(start.attachmentIds).toEqual([attachment.id]);
      expect(start.images?.map((image) => image.id)).toEqual([attachment.id]);
    }
    for (const task of h.db.listTasksByTurn(body.turnId)) {
      expect(h.db.getRun(task.run_id!)!.attachment_ids).toBe(JSON.stringify([attachment.id]));
    }
    expect(h.attachments.get(attachment.id)?.sessionId).toBe(sessionId);
  });

  it('gives a summoned agent the same turn attachments', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const attachment = await h.attachments.saveImage(pngBytes(), 'image/png');
    h.replies.set('claude', '结论在下面\n@审阅 你看一下这张图');

    await turns(h, sessionId, {
      prompt: '先由主答看',
      attachmentIds: [attachment.id],
    });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks.map((task) => task.source).sort()).toEqual(['leader_default', 'summon']);
    expect(h.starts).toHaveLength(2);
    for (const start of h.starts) {
      expect(start.attachmentIds).toEqual([attachment.id]);
    }
  });

  it('rejects an attachment owned by another session before writing the turn', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const attachment = await h.attachments.saveImage(pngBytes(), 'image/png');
    h.attachments.bind(attachment.id, { sessionId: 'someone-else' });

    const response = await turns(h, sessionId, {
      prompt: '不该写进去',
      attachmentIds: [attachment.id],
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('attachment_forbidden');
    expect(h.db.listTurns(sessionId, null, 10)).toHaveLength(0);
    expect(h.db.listMessages(sessionId)).toHaveLength(0);
  });

  it('refuses the whole turn when an addressed agent cannot receive images', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const attachment = await h.attachments.saveImage(pngBytes(), 'image/png');
    h.imageCapable.delete('codex');

    const response = await turns(h, sessionId, {
      prompt: '你俩都看',
      mentions: [review.agent_id],
      attachmentIds: [attachment.id],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('attachments_unsupported_agent');
    expect(body.error).toContain('审阅');
    expect(h.db.listTurns(sessionId, null, 10)).toHaveLength(0);
    expect(h.db.listMessages(sessionId)).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
  });

  it('validates attachment ids before creating a turn', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);

    expect(
      (await turns(h, sessionId, { prompt: '重复', attachmentIds: ['a', 'a'] })).status,
    ).toBe(400);
    expect(
      (await turns(h, sessionId, { prompt: '太多', attachmentIds: Array.from({ length: 9 }, (_, i) => `a${i}`) }))
        .status,
    ).toBe(400);
    expect((await turns(h, sessionId, { prompt: '没有', attachmentIds: ['missing'] })).status).toBe(404);
    expect(h.db.listTurns(sessionId, null, 10)).toHaveLength(0);
  });
});

describe('summon parsing', () => {
  it('ignores an @ that only appears in prose', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    h.replies.set('claude', '我建议以后可以用 @审阅 来复核这类改动。');

    await turns(h, sessionId, { prompt: '随便说说' });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks.some((task) => task.source === 'summon')).toBe(false);
  });
});

describe('turn idempotency', () => {
  it('re-attaches a retried commandId instead of asking twice', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);

    const first = await turns(h, sessionId, { prompt: '一次', commandId: 'cmd-1' });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { turnId: string };
    // The runner is fire-and-forget; let the first attempt actually start.
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');
    const startsAfterFirst = h.starts.length;

    const second = await turns(h, sessionId, { prompt: '一次', commandId: 'cmd-1' });
    expect(second.status).toBe(202);
    expect(((await second.json()) as { turnId: string }).turnId).toBe(firstBody.turnId);

    expect(h.db.listTurns(sessionId, null, 10)).toHaveLength(1);
    expect(h.db.listMessages(sessionId).filter((row) => row.role === 'user')).toHaveLength(1);
    // The retry must not start the same tasks a second time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.starts.length).toBe(startsAfterFirst);
  });

  it('refuses a commandId that another session already used, before writing', async () => {
    const h = await startApi();
    const first = seedRoom(h, []);
    const other = h.db.createSession({
      id: 's2',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: h.workspacePath,
    });

    expect((await turns(h, first, { prompt: 'a', commandId: 'shared' })).status).toBe(202);
    const second = await turns(h, other.id, { prompt: 'b', commandId: 'shared' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('command_id_conflict');

    // Nothing was written for the refused session: no orphan question, no turn.
    expect(h.db.listTurns(other.id, null, 10)).toHaveLength(0);
    expect(h.db.listMessages(other.id)).toHaveLength(0);
  });
});

describe('a turn is a batch, not a barrier', () => {
  it('gives every task the same snapshot so siblings cannot see each other', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;

    await turns(h, sessionId, { prompt: '都上', mentions: [leader.id, review.agent_id] });

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks).toHaveLength(2);
    // Same frozen position for both: neither can observe the other's answer.
    expect(new Set(tasks.map((task) => task.snapshot_seq)).size).toBe(1);
  });

  it('commits every answer onto one timeline, labelled by agent', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;

    await turns(h, sessionId, { prompt: '都上', mentions: [leader.id, review.agent_id] });
    // The runner is fire-and-forget; wait for the turn to settle.
    await waitFor(() => h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id)
      .every((task) => task.status !== 'queued' && task.status !== 'running'));

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks.every((task) => task.status === 'done')).toBe(true);
    // Each task has its own conversation handle.
    const threads = h.db.listAgentThreads(sessionId);
    expect(threads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(threads.map((thread) => thread.agent_id)).size).toBe(threads.length);

    // Exactly one user row (the turn committed it; the task runs must not add
    // one each), and each answer belongs to the agent that produced it.
    const messages = h.db.listMessages(sessionId);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const answers = messages.filter((message) => message.role === 'assistant');
    expect(answers).toHaveLength(2);
    expect(new Set(answers.map((message) => message.agent_id))).toEqual(
      new Set(tasks.map((task) => task.agent_id)),
    );
    for (const answer of answers) {
      expect(answer.committed_seq).not.toBeNull();
      expect(answer.task_id).not.toBeNull();
    }

    // Clients draw the user question once per turn, so every task run must
    // carry the turn id it belongs to.
    const turnId = h.db.listTurns(sessionId, null, 1)[0]!.id;
    for (const task of tasks) {
      expect(task.run_id).toBeTruthy();
      expect(h.db.getRun(task.run_id!)!.turn_id).toBe(turnId);
    }
  });

  it('uses the agent\'s model parameters on its room run', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const tuned = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '深思',
      kind: 'runtime',
      runtime: 'codex',
      readOnly: true,
      modelParameters: { reasoningEffort: 'high' },
    });

    await turns(h, sessionId, { prompt: '仔细想', mentions: [tuned.id] });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    expect(h.starts.at(-1)!.modelParameters).toEqual({ reasoningEffort: 'high' });
  });

  it('stores each run event once, not once per stream', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    await turns(h, sessionId, { prompt: '一次' });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const [task] = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(task!.run_id).toBeTruthy();
    const events = h.db.listEvents(task!.run_id!);
    expect(events.length).toBeGreaterThan(0);
    // (run_id, seq) must be unique: the room path tags the per-run row rather
    // than inserting a second copy of every frame.
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    expect(events.every((event) => event.session_id === sessionId)).toBe(true);
    expect(events.every((event) => event.room_seq !== null)).toBe(true);
  });

  it('publishes a failed task when its driver never starts', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const missing = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '失踪运行时',
      kind: 'runtime',
      runtime: 'missing-runtime',
      readOnly: true,
    });
    addToSession(h.db, { id: sessionId, workspaceId: h.workspaceId }, missing.id);

    const response = await turns(h, sessionId, {
      prompt: '启动一下',
      mentions: [missing.id],
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { turnId: string };
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const [task] = h.db.listTasksByTurn(body.turnId);
    expect(task!.status).toBe('failed');
    expect(task!.run_id).toBeTruthy();
    expect(h.db.getRun(task!.run_id!)!.status).toBe('failed');
    const events = h.db.listRoomEvents(sessionId);
    expect(events.some((event) => {
      const payload = JSON.parse(event.payload) as { type?: string; code?: string };
      return payload.type === 'error' && payload.code === 'task_failed';
    })).toBe(true);
  });

  it('does not cancel siblings when one agent fails', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;
    // The member runs on codex; make that one fail.
    h.failures.add('codex');

    await turns(h, sessionId, { prompt: '都上', mentions: [leader.id, review.agent_id] });
    await waitFor(() => h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id)
      .every((task) => task.status !== 'queued' && task.status !== 'running'));

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    const byAgent = new Map(tasks.map((task) => [task.agent_id, task.status]));
    expect(byAgent.get(leader.id)).toBe('done');
    expect(byAgent.get(review.agent_id)).toBe('failed');
  });

  it('closes the turn once its tasks settle', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    await turns(h, sessionId, { prompt: '一个任务' });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');
    expect(h.db.listTurns(sessionId, null, 1)[0]!.status).toBe('done');
  });
});

describe('single writable rule', () => {
  it('refuses a second writable member at save time', async () => {
    const h = await startApi();
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const sessionId = seedRoom(h, []);
    const writer = createAgent(h.db, workspace, {
      workspaceId: h.workspaceId,
      name: '另一个写者',
      kind: 'runtime',
      runtime: 'codex',
      readOnly: false,
    });
    const response = await h.request('POST', `/api/sessions/${sessionId}/agents`, {
      agentId: writer.id,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('writable_agent_exists');
  });

  it('refuses turning an existing read-only member into a second writer', async () => {
    const h = await startApi();
    const workspace = h.db.getWorkspace(h.workspaceId)!;
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;

    expect(() => updateAgent(h.db, workspace, review.agent_id, { readOnly: false })).toThrowError(
      /already has a writable agent/,
    );
    expect(h.db.getAgent(review.agent_id)!.read_only).toBe(1);
  });
});

describe('room projection into a task prompt', () => {
  it('shows what was committed before the snapshot, minus the agent itself', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;

    // One batch: same snapshot, so neither sibling can see the other.
    await turns(h, sessionId, { prompt: '都上', mentions: [leader.id, review.agent_id] });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');
    expect(h.starts.every((start) => !start.prompt.includes('<room-context'))).toBe(true);

    // Addressed alone, the member sees the user and the leader — not itself.
    await turns(h, sessionId, { prompt: '审阅再看看', mentions: [review.agent_id] });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const prompt = h.starts.at(-1)!.prompt;
    expect(prompt).toContain('<room-context');
    expect(prompt).toContain('[用户] 都上');
    expect(prompt).toContain('[默认] claude 回答');
    expect(prompt).not.toContain('[审阅] codex 回答');
    // The current question is the prompt itself, not a second copy in the block.
    expect(prompt.split('审阅再看看')).toHaveLength(2);

    // Its room cursor advanced to the point it was shown.
    const turn = h.db.listTurns(sessionId, null, 1)[0]!;
    const [task] = h.db.listTasksByTurn(turn.id);
    expect(h.db.getAgentThread(sessionId, review.agent_id)!.last_seen_seq).toBe(
      task!.snapshot_seq,
    );

    // The leader's next turn sees the reviewer and not its own earlier answer.
    await turns(h, sessionId, { prompt: '默认怎么看', mentions: [leader.id] });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');
    const leaderPrompt = h.starts.at(-1)!.prompt;
    expect(leaderPrompt).toContain('[审阅] codex 回答');
    expect(leaderPrompt).not.toContain('[默认] claude 回答');
  });
});

describe('leader summon', () => {
  it('turns the leader’s @ into a supplement task that can see the main answer', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;
    h.replies.set('claude', '我怀疑是连接池太小。\n@审阅 补充一下');

    await turns(h, sessionId, { prompt: '并发有问题吗' });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const turn = h.db.listTurns(sessionId, null, 1)[0]!;
    const tasks = h.db.listTasksByTurn(turn.id);
    const main = tasks.find((task) => task.agent_id === leader.id)!;
    const summon = tasks.find((task) => task.agent_id === review.agent_id)!;

    expect(tasks).toHaveLength(2);
    expect(main.source).toBe('leader_default');
    expect(summon.source).toBe('summon');
    expect(summon.parent_task_id).toBe(main.id);
    // I25: the supplement was created after the main answer committed.
    const mainMessage = h.db.listMessages(sessionId).find((m) => m.id === main.message_id)!;
    expect(summon.snapshot_seq!).toBeGreaterThanOrEqual(mainMessage.committed_seq!);

    const start = h.starts.at(-1)!;
    // The leader's answer is in the room projection exactly once; the task
    // prompt is only the instruction to supplement it.
    expect(start.prompt.match(/我怀疑是连接池太小/g)).toHaveLength(1);
    expect(start.prompt).toContain('[默认] 我怀疑是连接池太小');
    expect(summon.prompt).not.toContain('我怀疑是连接池太小');
    expect(turn.status).toBe('done');
  });

  it('lets a summoned agent reply to the leader exactly once', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;
    h.replies.set('claude', '我先给出主结论。\n@审阅 请你补充');
    h.replies.set('codex', `@${leader.name} 我的补充结论是 X`);

    const response = await turns(h, sessionId, { prompt: '一起判断一下' });
    expect(response.status).toBe(202);
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks.map((task) => task.source).sort()).toEqual([
      'leader_default',
      'reply',
      'summon',
    ]);
    const summon = tasks.find((task) => task.source === 'summon')!;
    const reply = tasks.find((task) => task.source === 'reply')!;
    expect(reply.agent_id).toBe(leader.id);
    expect(reply.parent_task_id).toBe(summon.id);
    // The leader's reply task itself contains @审阅, but source=reply is a
    // terminal edge and must not spawn a fourth task.
    expect(tasks).toHaveLength(3);
  });

  it('does not let an explicitly addressed member summon back', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    h.replies.set('codex', '好的。@默认 你也看看');

    await turns(h, sessionId, { prompt: '审阅看下', mentions: [review.agent_id] });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const tasks = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toBe('mention');
  });

  it('caps at three, drops duplicates and never picks the leader itself', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅', '记录', '性能', '安全']);
    const leader = getLeader(h.db, sessionId)!;
    h.replies.set('claude', '@审阅 @审阅 @记录 @性能 @安全 @默认 大家都看看');

    await turns(h, sessionId, { prompt: '都看看' });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const summons = h.db
      .listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id)
      .filter((task) => task.source === 'summon');
    expect(summons.map((task) => h.db.getAgent(task.agent_id)!.name)).toEqual([
      '审阅',
      '记录',
      '性能',
    ]);
    expect(summons.some((task) => task.agent_id === leader.id)).toBe(false);
  });
});

describe('room stream', () => {
  it('carries frames for every task with a single session cursor', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, ['审阅']);
    const review = h.db.listSessionAgents(sessionId).find((row) => row.role === 'member')!;
    const leader = getLeader(h.db, sessionId)!;

    const controller = new AbortController();
    const frames: { roomSeq: number; agentId: string | null }[] = [];
    const streamPromise = readRoomStream(h, sessionId, controller.signal, (frame) => frames.push(frame));

    await turns(h, sessionId, { prompt: '都上', mentions: [leader.id, review.agent_id] });
    await waitFor(() => {
      const agentIds = new Set(frames.map((frame) => frame.agentId).filter(Boolean));
      const settled = h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id)
        .every((task) => task.status === 'done' || task.status === 'failed');
      return agentIds.size === 2 && settled;
    });
    controller.abort();
    await streamPromise;

    // Frames from both agents arrived on one connection...
    const agentIds = new Set(frames.map((frame) => frame.agentId).filter(Boolean));
    expect(agentIds.size).toBe(2);
    // ...and the cursor is strictly increasing, which is what makes resume work.
    const seqs = frames.map((frame) => frame.roomSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('replays from a cursor so a reconnecting client misses nothing', async () => {
    const h = await startApi();
    const sessionId = seedRoom(h, []);
    await turns(h, sessionId, { prompt: '第一句' });
    await waitFor(() => h.db.listTurns(sessionId, null, 1)[0]!.status !== 'running');

    const controller = new AbortController();
    const frames: { roomSeq: number }[] = [];
    const streamPromise = readRoomStream(h, sessionId, controller.signal, (frame) => frames.push(frame), 0);
    await waitFor(() => frames.length > 0);
    controller.abort();
    await streamPromise;

    // Replay starts at 1 and never repeats a position.
    expect(frames[0]!.roomSeq).toBe(1);
    const seqs = frames.map((frame) => frame.roomSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('404s for an unknown session', async () => {
    const h = await startApi();
    expect((await h.request('GET', '/api/sessions/nope/stream')).status).toBe(404);
  });
});

async function readRoomStream(
  h: Harness,
  sessionId: string,
  signal: AbortSignal,
  onFrame: (frame: { roomSeq: number; agentId: string | null }) => void,
  after?: number,
): Promise<void> {
  const url = new URL(`${h.base}/api/sessions/${sessionId}/stream`);
  if (after !== undefined) url.searchParams.set('after', String(after));
  const response = await fetch(url, { signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            onFrame(JSON.parse(line.slice(5).trim()));
          } catch {
            // Not every `data:` line is a frame we care about in this test.
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // aborted
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
