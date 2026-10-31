import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app/context';
import type { NormalizedEvent } from '../src/types/api';
import { Db } from '../src/db/db';
import { captureCheckpoint, repoRootFor } from '../src/workspaces/checkpoints';
import { registerChatRoutes } from '../src/routes/chat';
import { registerRunRoutes } from '../src/routes/runs';
import { RunNotifier } from '../src/runs/run-notifier';
import { PermissionManager } from '../src/permissions/permissions';
import { registerActiveRun } from '../src/runtimes/active-runs';

// Control the git boundary to exercise requests arriving during each snapshot.
vi.mock('../src/workspaces/checkpoints', () => ({ captureCheckpoint: vi.fn(), repoRootFor: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const finished = { status: 'succeeded', exitCode: 0, error: null };
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.mocked(repoRootFor).mockResolvedValue('/tmp');
  vi.mocked(captureCheckpoint).mockReset().mockResolvedValue('snapshot');
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(detecting = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-lifecycle-'));
  const db = new Db(':memory:');
  const workspace = db.seedDefaultWorkspace(dir, 'ask')!;
  db.createSession({ id: 's', runtime: 'claude', workspaceId: workspace.id, permissionMode: 'ask', cwd: dir });
  const outcome = deferred<typeof finished>();
  const detection = deferred<{ available: boolean }>();
  const start = vi.fn((req: { runId: string; onEvent(event: NormalizedEvent): void }) => {
    const run = { id: req.runId, promise: outcome.promise, cancel: () => {} };
    registerActiveRun(run);
    return run;
  });
  const detect = vi.fn(() => detection.promise);
  const ctx = {
    db, registry: { driver: () => ({ start }), detection: () => detecting ? undefined : { available: true }, detect },
    notifier: new RunNotifier(), permissions: new PermissionManager(), config: {}, hookPath: '',
  } as unknown as AppContext;
  const app = express(); app.use(express.json()); registerChatRoutes(app, ctx); registerRunRoutes(app, ctx);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    outcome.resolve(finished);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (commandId: string) => fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', prompt: 'hello', commandId }),
  });
  return { db, post, start, detect, detection, outcome, base };
}

describe('chat lifecycle serialization', () => {
  it('rejects a second command during the pre-checkpoint', async () => {
    const pre = deferred<string>();
    vi.mocked(captureCheckpoint).mockImplementationOnce(() => pre.promise);
    const { post, start, outcome, db } = await setup();
    const first = post('one');
    await vi.waitFor(() => expect(captureCheckpoint).toHaveBeenCalledOnce());
    const second = await post('two');
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'session_busy' });
    expect(db.listRuns('s')).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
    pre.resolve('pre'); outcome.resolve(finished);
    await (await first).text();
  });

  it('keeps same-command retries attached before the driver starts', async () => {
    const pre = deferred<string>();
    vi.mocked(captureCheckpoint).mockImplementationOnce(() => pre.promise);
    const { post, start, outcome } = await setup();
    const first = post('same');
    await vi.waitFor(() => expect(captureCheckpoint).toHaveBeenCalledOnce());
    const retry = await post('same');
    let ended = false;
    const replay = retry.text().then((text) => { ended = true; return text; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(false);
    pre.resolve('pre'); outcome.resolve(finished);
    const [original, repeated] = await Promise.all([(await first).text(), replay]);
    expect(repeated).toContain('"terminal":true');
    expect(repeated).toBe(original);
    expect(start).toHaveBeenCalledOnce();
  });

  it('rechecks the session after concurrent runtime detection', async () => {
    const { post, detect, detection, outcome, start } = await setup(true);
    const requests = [post('one'), post('two')];
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
    detection.resolve({ available: true });
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(start).toHaveBeenCalledOnce();
    outcome.resolve(finished);
    await Promise.all(responses.map((r) => r.text()));
  });

  it('rechecks command id after concurrent runtime detection', async () => {
    const { post, detect, detection, outcome, start, db } = await setup(true);
    const requests = [post('same'), post('same')];
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
    detection.resolve({ available: true });
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    outcome.resolve(finished);
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(texts[0]).toBe(texts[1]);
    expect(db.listRuns('s')).toHaveLength(1);
    expect(start).toHaveBeenCalledOnce();
  });

  it('drops thinking deltas from the stream and the events table', async () => {
    const { post, outcome, start, db } = await setup();
    const response = await post('think');
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    start.mock.calls[0][0].onEvent({ type: 'thinking_start' });
    start.mock.calls[0][0].onEvent({ type: 'thinking_delta', delta: 'secret thought' });
    start.mock.calls[0][0].onEvent({ type: 'text_delta', delta: 'visible' });
    outcome.resolve(finished);
    const text = await response.text();

    expect(text).toContain('"type":"thinking_start"');
    expect(text).toContain('"type":"text_delta"');
    expect(text).not.toContain('thinking_delta');
    expect(text).not.toContain('secret thought');

    const run = db.listRuns('s')[0];
    expect(db.listEvents(run.id).map((row) => row.type)).toEqual([
      'status',
      'thinking_start',
      'text_delta',
      'status',
    ]);
  });

  it('hides legacy thinking deltas when replaying a finished run', async () => {
    const { post, outcome, start, db, base } = await setup();
    const response = await post('legacy');
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    outcome.resolve(finished);
    await response.text();

    const run = db.listRuns('s')[0];
    // Rows recorded before the daemon stopped persisting thinking content.
    db.appendEvent(run.id, 100, 'thinking_delta', { type: 'thinking_delta', delta: 'old thought' });

    // The exclusion must happen in SQL, not after loading every payload in Node.
    expect(db.listEvents(run.id).some((row) => row.type === 'thinking_delta')).toBe(true);
    expect(db.listReplayEvents(run.id).some((row) => row.type === 'thinking_delta')).toBe(false);

    const replay = await fetch(`${base}/api/runs/${run.id}/events`).then((r) => r.json());
    expect(replay.events.some((frame: { event: { type: string } }) => frame.event.type === 'thinking_delta')).toBe(false);

    const stream = await fetch(`${base}/api/runs/${run.id}/stream`).then((r) => r.text());
    expect(stream).not.toContain('thinking_delta');
    expect(stream).not.toContain('old thought');
  });

  it('keeps the session busy until the post-checkpoint completes', async () => {
    const postCheckpoint = deferred<string>();
    vi.mocked(captureCheckpoint).mockResolvedValueOnce('pre').mockImplementationOnce(() => postCheckpoint.promise);
    const { post, outcome, db, start, base } = await setup();
    const first = await post('one');
    start.mock.calls[0][0].onEvent({ type: 'error', code: 'provider_error', message: 'early', terminal: true });
    outcome.resolve(finished);
    await vi.waitFor(() => expect(captureCheckpoint).toHaveBeenCalledTimes(2));
    const run = db.listRuns('s')[0];
    expect(run.status).toBe('running');
    const live = await fetch(`${base}/api/runs`).then((response) => response.json());
    expect(live.runs).toEqual([expect.objectContaining({ id: run.id })]);
    const rollback = await fetch(`${base}/api/runs/${run.id}/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    expect(rollback.status).toBe(409);
    expect(await rollback.json()).toMatchObject({ code: 'run_active' });
    const second = await post('two');
    expect(second.status).toBe(409);
    postCheckpoint.resolve('post');
    const text = await first.text();
    expect(text).toContain('"terminal":false');
    expect(text.match(/"terminal":true/g)).toHaveLength(1);
    expect(db.listRuns('s')[0].status).toBe('succeeded');
  });

  it('bumps session recency when the run starts, not only when it ends', async () => {
    const { post, outcome, db, start } = await setup();
    const cwd = db.getSession('s')!.cwd;
    const workspaceId = db.getDefaultWorkspace()!.id;

    // A newer session sits above `s` until `s` actually starts a run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const other = db.createSession({ id: 'other', runtime: 'claude', workspaceId, permissionMode: 'ask', cwd });
    expect(other.last_active_at).toBeGreaterThan(db.getSession('s')!.last_active_at);

    const pending = post('recency');
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    // Still running (the driver promise has not settled), yet `s` is on top.
    expect(db.listSessions()[0].id).toBe('s');
    expect(db.getSession('s')!.last_active_at).toBeGreaterThan(other.last_active_at);

    outcome.resolve(finished);
    await (await pending).text();
  });
});
