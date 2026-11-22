import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { registerSessionRoutes } from '../src/routes/sessions';
import { RunNotifier } from '../src/runs/run-notifier';
import { SessionNotifier } from '../src/runs/session-notifier';
import type { SessionEvent } from '../src/types/api';

const servers: Server[] = [];
const dbs: Db[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const db of dbs.splice(0)) db.close();
});

interface Harness {
  db: Db;
  base: string;
  sessionId: string;
  notifier: SessionNotifier;
}

async function setup(): Promise<Harness> {
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.createWorkspace({ name: 'demo', path: '/tmp/paboot-session-events' });
  const session = db.createSession({
    id: 'session-1',
    runtime: 'builtin',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
    title: 'hello',
  });
  const notifier = new SessionNotifier();
  const ctx = {
    db,
    registry: {
      driver: () => ({ id: 'builtin', start: () => { throw new Error('not used'); } }),
      detection: () => ({ available: true }),
      detect: async () => ({ available: true }),
    },
    notifier: new RunNotifier(),
    sessionNotifier: notifier,
    config: {},
    builtinConfig: { securityProfile: 'local' },
    hookPath: '',
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    db,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sessionId: session.id,
    notifier,
  };
}

/** Read SSE `data:` payloads off a live response. */
async function openEvents(base: string, sessionId: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/sessions/${sessionId}/events`, {
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    status: res.status,
    close: () => controller.abort(),
    async next(): Promise<SessionEvent> {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = block.split('\n').find((item) => item.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6)) as SessionEvent;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error('session event stream ended unexpectedly');
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

describe('session creation', () => {
  it('creates a chat session without starting a run', async () => {
    const h = await setup();
    const response = await fetch(`${h.base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: h.db.getSession(h.sessionId)!.workspace_id,
        runtime: 'builtin',
        permissionMode: 'ask',
        title: '第一条消息',
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      session: { id: string; title: string | null; runtime: string; running: boolean };
    };
    expect(body.session).toMatchObject({
      title: '第一条消息',
      runtime: 'builtin',
      running: false,
    });
    expect(h.db.getSession(body.session.id)).toBeTruthy();
    expect(h.db.listRuns(body.session.id)).toHaveLength(0);
  });
});

describe('session event stream', () => {
  it('starts with a state snapshot, then forwards run and title hints', async () => {
    const h = await setup();
    const stream = await openEvents(h.base, h.sessionId);
    expect(stream.status).toBe(200);

    const state = await stream.next();
    expect(state.type).toBe('state');
    if (state.type === 'state') {
      expect(state.session.id).toBe(h.sessionId);
      expect(state.session.title).toBe('hello');
      expect(state.session.runningRunId).toBeNull();
    }

    h.notifier.publish(h.sessionId, {
      type: 'run_started',
      sessionId: h.sessionId,
      run: {
        id: 'run-1',
        prompt: 'from the phone',
        attachmentIds: [],
        startedAt: 1,
        status: 'running',
      },
    });
    const started = await stream.next();
    expect(started).toMatchObject({ type: 'run_started', run: { id: 'run-1' } });

    h.notifier.publish(h.sessionId, { type: 'session_updated', sessionId: h.sessionId, title: 'new title' });
    const renamed = await stream.next();
    expect(renamed).toEqual({ type: 'session_updated', sessionId: h.sessionId, title: 'new title' });

    stream.close();
  });

  it('reports every active room run instead of collapsing to one', async () => {
    const h = await setup();
    for (const id of ['r1', 'r2']) {
      h.db.createRun({
        id,
        sessionId: h.sessionId,
        runtime: 'builtin',
        model: null,
        prompt: 'hi',
        status: 'running',
      });
    }
    const response = await fetch(`${h.base}/api/sessions/${h.sessionId}`);
    const body = (await response.json()) as {
      session: { running: boolean; runningRunId: string | null; runningRunIds?: string[] };
    };
    expect(body.session.running).toBe(true);
    expect(body.session.runningRunId).toBe('r1');
    expect(body.session.runningRunIds).toEqual(['r1', 'r2']);
  });

  it('exposes the answer commit position used to rebuild room order', async () => {
    const h = await setup();
    h.db.createRun({
      id: 'r1',
      sessionId: h.sessionId,
      runtime: 'builtin',
      model: null,
      prompt: 'hi',
      status: 'succeeded',
      taskId: 'task-1',
    });
    h.db.addMessage(h.sessionId, 'assistant', '答案', {
      agentId: 'a1',
      taskId: 'task-1',
      commit: true,
    });
    const response = await fetch(`${h.base}/api/sessions/${h.sessionId}`);
    const body = (await response.json()) as {
      runs: { answerCommittedSeq?: number | null }[];
    };
    expect(body.runs[0]!.answerCommittedSeq).toBe(1);
  });

  it('publishes a title change made through PATCH', async () => {
    const h = await setup();
    const stream = await openEvents(h.base, h.sessionId);
    await stream.next(); // state

    const res = await fetch(`${h.base}/api/sessions/${h.sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed elsewhere' }),
    });
    expect(res.status).toBe(200);

    expect(await stream.next()).toEqual({
      type: 'session_updated',
      sessionId: h.sessionId,
      title: 'renamed elsewhere',
    });
    stream.close();
  });

  it('404s for unknown sessions', async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/api/sessions/missing/events`);
    expect(res.status).toBe(404);
  });
});
