import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { addToSession, createAgent, getLeader } from '../src/agents/index';
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
  /** Reply text the stub driver produces, keyed by runtime id. */
  replies: Map<string, string>;
  failures: Set<string>;
  request: (method: string, url: string, body?: unknown) => Promise<Response>;
}

async function startApi(): Promise<Harness> {
  const workspacePath = fs.realpathSync(tempDir('paboot-room-'));
  const db = new Db(':memory:');
  const workspace = db.createWorkspace({ name: 'demo', path: workspacePath });

  const starts: RuntimeDriverRequest[] = [];
  const replies = new Map<string, string>();
  const failures = new Set<string>();

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
  registerRoomRoutes(app, ctx);
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
    replies,
    failures,
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

  it('404s for an unknown session', async () => {
    const h = await startApi();
    expect((await turns(h, 'nope', { prompt: 'hi' })).status).toBe(404);
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
    await waitFor(() => frames.length > 0);
    await waitFor(() => h.db.listTasksByTurn(h.db.listTurns(sessionId, null, 1)[0]!.id)
      .every((task) => task.status === 'done' || task.status === 'failed'));
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
