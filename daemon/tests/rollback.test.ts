import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { captureCheckpoint } from '../src/checkpoints';
import { Db } from '../src/db';
import { registerChangesRoutes } from '../src/routes/changes';
import { registerRunRoutes } from '../src/routes/runs';

const dbs: Db[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A git repo with one committed file, plus a workspace/session pointing at it. */
async function setup(): Promise<{ db: Db; base: string; repo: string; sessionId: string }> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-rb-'));
  dirs.push(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'init']);

  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.seedDefaultWorkspace(repo, 'ask');
  if (!workspace) throw new Error('expected a seeded workspace');
  const sessionId = 's-1';
  db.createSession({ id: sessionId, runtime: 'claude', workspaceId: workspace.id, permissionMode: 'ask', cwd: repo });

  const ctx = { db } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerRunRoutes(app, ctx);
  registerChangesRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, repo, sessionId };
}

/** A completed run that changed `a.txt` and added `new.txt`, with a checkpoint row. */
async function completedRun(db: Db, repo: string, sessionId: string, id: string): Promise<void> {
  const preRef = (await captureCheckpoint(repo, `${id}-pre`))!;
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hi\n');
  const postRef = (await captureCheckpoint(repo, `${id}-post`))!;
  db.createRun({ id, sessionId, runtime: 'claude', model: null, prompt: 'p', status: 'succeeded' });
  db.upsertRunCheckpoint({ runId: id, repoRoot: repo, preRef, postRef, status: 'complete' });
}

async function post(base: string, url: string, body: unknown) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/runs/:id/rollback', () => {
  it('restores the tree and marks the run rolled_back', async () => {
    const { db, base, repo, sessionId } = await setup();
    await completedRun(db, repo, sessionId, 'r1');

    const res = await post(base, '/api/runs/r1/rollback', { confirm: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, rolledBackRuns: 1, conversationRewound: false });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false);
    expect(db.getRun('r1')?.status).toBe('rolled_back');
    expect(db.getRunCheckpoint('r1')?.status).toBe('rolled_back');
  });

  it('requires confirm and a checkpoint', async () => {
    const { db, base, repo, sessionId } = await setup();
    await completedRun(db, repo, sessionId, 'r1');
    db.createRun({ id: 'r2', sessionId, runtime: 'claude', model: null, prompt: 'p', status: 'succeeded' });

    expect((await post(base, '/api/runs/r1/rollback', {})).status).toBe(400);
    expect((await post(base, '/api/runs/r2/rollback', { confirm: true })).body.code).toBe('no_checkpoint');
    expect((await post(base, '/api/runs/nope/rollback', { confirm: true })).status).toBe(404);
  });

  it('refuses to discard later runs unless forced', async () => {
    const { db, base, repo, sessionId } = await setup();
    await completedRun(db, repo, sessionId, 'r1');
    await new Promise((resolve) => setTimeout(resolve, 2));
    db.createRun({ id: 'r2', sessionId, runtime: 'claude', model: null, prompt: 'p', status: 'succeeded' });

    const blocked = await post(base, '/api/runs/r1/rollback', { confirm: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'later_runs_exist', laterRuns: 1 });

    const forced = await post(base, '/api/runs/r1/rollback', { confirm: true, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.rolledBackRuns).toBe(2);
    expect(db.getRun('r2')?.status).toBe('rolled_back');
  });
});
