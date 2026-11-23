import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { KnowledgeStore } from '../src/knowledge/store';
import { PermissionManager } from '../src/permissions/permissions';
import { RunNotifier } from '../src/runs/run-notifier';
import { startSessionRun, type RunSink } from '../src/runs/run-service';
import { SessionNotifier } from '../src/runs/session-notifier';
import { titleFromPrompt } from '../src/runs/session-title';
import type { RuntimeDriver } from '../src/runtimes/RuntimeDriver';

const dbs: Db[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
const envBackup = new Map<string, string | undefined>();

afterEach(async () => {
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  for (const db of dbs.splice(0)) db.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  process.env[key] = value;
}

/** One OpenAI-compatible SSE server returning `Title: "<text>"`. */
async function fakeTitleProvider(title: string): Promise<{ url: string; prompts: string[] }> {
  const state = { url: '', prompts: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
      state.prompts.push(parsed.messages?.at(-1)?.content ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Title: "${title}"` }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  servers.push(server);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function useProvider(baseUrl: string): void {
  setEnv(
    'PABOOT_LLM_PROVIDERS',
    JSON.stringify({
      providers: [
        {
          id: 'fake',
          kind: 'openai',
          baseUrl,
          apiKey: 'fake-key',
          models: [{ id: 'fake-model' }],
        },
      ],
    }),
  );
  setEnv('PABOOT_LLM_PROVIDERS_FILE', path.join(tempDir('paboot-title-empty-'), 'missing.json'));
}

interface Harness {
  ctx: AppContext;
  db: Db;
  workspaceId: string;
  run: (sessionId: string, prompt: string) => Promise<void>;
}

function harness(runtime = 'claude'): Harness {
  const root = tempDir('paboot-title-workspace-');
  const dataDir = tempDir('paboot-title-data-');
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.seedDefaultWorkspace(root, 'ask');
  if (!workspace) throw new Error('workspace not created');
  const driver: RuntimeDriver = {
    id: runtime,
    start(req) {
      return {
        id: req.runId,
        promise: Promise.resolve({ status: 'succeeded', exitCode: 0, error: null }),
        cancel: () => {},
      };
    },
  };
  const registry = {
    driver: (id: string) => (id === runtime ? driver : undefined),
    detection: () => null,
    detect: async () => null,
    list: () => [{ id: runtime }],
  };
  const ctx = {
    config: { dataDir, host: '127.0.0.1', port: 0, permissionMode: 'ask', runIdleTimeoutMs: 0 },
    db,
    knowledge: new KnowledgeStore(dataDir),
    registry,
    permissions: new PermissionManager(1_000),
    notifier: new RunNotifier(),
    sessionNotifier: new SessionNotifier(),
  } as unknown as AppContext;
  return {
    ctx,
    db,
    workspaceId: workspace.id,
    async run(sessionId, prompt) {
      const session = db.getSession(sessionId)!;
      const ws = db.getWorkspace(workspace.id)!;
      const sink: RunSink = { frame() {} };
      const handle = startSessionRun(ctx, {
        session,
        workspace: ws,
        prompt,
        driver,
        permissionMode: 'ask',
        model: null,
        modelParameters: null,
        trigger: 'user',
        sink,
      });
      await handle.done;
    },
  };
}

async function waitForTitle(db: Db, sessionId: string, expected: string): Promise<string | null> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const title = db.getSession(sessionId)?.title ?? null;
    if (title === expected) return title;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return db.getSession(sessionId)?.title ?? null;
}

describe('auto session titles for directly connected runtimes', () => {
  it('generates a title through the configured background model on the first turn', async () => {
    const provider = await fakeTitleProvider('Claude title');
    useProvider(provider.url);

    const h = harness('claude');
    const session = h.db.createSession({
      id: 'claude-session',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: tempDir('paboot-title-cwd-'),
      title: titleFromPrompt('Fix the login 500 error'),
    });
    h.db.setSetting('memory_model', 'fake:fake-model');

    await h.run(session.id, 'Fix the login 500 error');

    expect(await waitForTitle(h.db, session.id, 'Claude title')).toBe('Claude title');
    expect(provider.prompts[0]).toContain('login 500 error');
  });

  it('keeps a title the user renamed before the first turn', async () => {
    const provider = await fakeTitleProvider('Should not appear');
    useProvider(provider.url);

    const h = harness('claude');
    const session = h.db.createSession({
      id: 'renamed-session',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: tempDir('paboot-title-cwd-'),
      title: 'My own title',
    });
    h.db.setSetting('memory_model', 'fake:fake-model');

    await h.run(session.id, 'Fix the login 500 error');
    // Give a mistaken generation a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(h.db.getSession(session.id)?.title).toBe('My own title');
    expect(provider.prompts).toHaveLength(0);
  });

  it('leaves the default title when no background model is configured', async () => {
    const h = harness('claude');
    const session = h.db.createSession({
      id: 'no-model-session',
      runtime: 'claude',
      workspaceId: h.workspaceId,
      permissionMode: 'ask',
      cwd: tempDir('paboot-title-cwd-'),
      title: titleFromPrompt('Fix the login 500 error'),
    });

    await h.run(session.id, 'Fix the login 500 error');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(h.db.getSession(session.id)?.title).toBe('Fix the login 500 error');
  });
});
