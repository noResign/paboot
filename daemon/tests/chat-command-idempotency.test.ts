import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { Db } from '../src/db';
import { PermissionManager } from '../src/permissions';
import { RunNotifier } from '../src/run-notifier';
import { registerChatRoutes } from '../src/routes/chat';
import { registerActiveRun } from '../src/runtimes/active-runs';

const dbs: Db[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const db of dbs.splice(0)) db.close();
});

function openDb(): Db {
  const db = new Db(':memory:');
  dbs.push(db);
  return db;
}

/**
 * A runtime whose run resolves at once, so a POST's SSE stream ends immediately
 * and the tests can read the whole response. This stands in for the provider
 * transport — the only boundary orchestration tests are allowed to fake.
 */
function makeCtx(db: Db): AppContext {
  return {
    db,
    registry: {
      driver: () => ({
        start: (req: { runId: string }) => {
          const run = {
            id: req.runId,
            promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
            cancel: () => {},
          };
          registerActiveRun(run);
          return run;
        },
      }),
      detection: () => ({ available: true }),
      detect: async () => ({ available: true }),
    },
    permissions: new PermissionManager(),
    notifier: new RunNotifier(),
    config: { host: '127.0.0.1', port: 0, tls: false, runIdleTimeoutMs: 0, permissionTimeoutMs: 1000, token: 't' },
    hookPath: '',
  } as unknown as AppContext;
}

async function startApi(db: Db): Promise<string> {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, makeCtx(db));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function postChat(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('POST /api/chat command idempotency', () => {
  // A dropped response or a flaky link makes a client resend the same request.
  // With a command id that must re-attach, not run the agent twice.
  it('a retry with the same commandId re-attaches instead of starting a second run', async () => {
    const db = openDb();
    db.seedDefaultWorkspace(process.cwd(), 'ask');
    const base = await startApi(db);

    const first = await postChat(base, { prompt: 'hi', commandId: 'cmd-1' });
    expect(first.status).toBe(200);
    const sessionId = db.listSessions()[0].id;
    const runs = db.listRuns(sessionId);
    expect(runs).toHaveLength(1);

    const second = await postChat(base, { prompt: 'hi', commandId: 'cmd-1' });
    expect(second.status).toBe(200);
    // Same run, no second one — and the replay carries the original run's frames.
    expect(db.listRuns(sessionId)).toHaveLength(1);
    expect(db.listSessions()).toHaveLength(1);
    expect(second.text).toContain(runs[0].id);
  });

  it('refuses a commandId already used for a different session', async () => {
    const db = openDb();
    db.seedDefaultWorkspace(process.cwd(), 'ask');
    const base = await startApi(db);

    await postChat(base, { prompt: 'hi', commandId: 'cmd-2' });

    const conflict = await postChat(base, { prompt: 'hi', commandId: 'cmd-2', sessionId: 'other-session' });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.text)).toMatchObject({ code: 'command_id_conflict' });
  });

  it('without a commandId each request starts its own run', async () => {
    const db = openDb();
    db.seedDefaultWorkspace(process.cwd(), 'ask');
    const base = await startApi(db);

    await postChat(base, { prompt: 'a' });
    const sessionId = db.listSessions()[0].id;
    await postChat(base, { prompt: 'b', sessionId });

    expect(db.listRuns(sessionId)).toHaveLength(2);
  });
});
