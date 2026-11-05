import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../src/app/context';
import { AttachmentStore } from '../src/attachments/store';
import { Db } from '../src/db/db';
import { KnowledgeStore } from '../src/knowledge/store';
import { PermissionManager } from '../src/permissions/permissions';
import { RunNotifier } from '../src/runs/run-notifier';
import { startSessionRun, type RunSink } from '../src/runs/run-service';
import { createBuiltinDriver } from '../src/runtimes/builtin/driver';
import { createRegistry } from '../src/runtimes/registry';
import type { SseFrame } from '../src/types/api';

/**
 * Opt-in full builtin-driver smoke test against the real DeepSeek API.
 * The key is only read from the environment and never written to source.
 *
 *   PABOOT_LIVE_DEEPSEEK_API=1 DEEPSEEK_API_KEY=... pnpm test -- tests/live-deepseek-driver.test.ts
 */
const live = process.env.PABOOT_LIVE_DEEPSEEK_API === '1' && Boolean(process.env.DEEPSEEK_API_KEY);
const liveDescribe = live ? describe : describe.skip;
const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function png1x1(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

function setup() {
  const apiKey = process.env.DEEPSEEK_API_KEY!;
  process.env.PABOOT_LLM_PROVIDERS = JSON.stringify({
    providers: [{
      id: 'deepseek',
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey,
      models: [{
        id: 'deepseek-flash',
        label: 'DeepSeek Flash',
        supportsTools: true,
        supportsImages: true,
      }],
    }],
  });
  process.env.PABOOT_LLM_PROVIDERS_FILE = path.join(tempDir('paboot-live-empty-'), 'missing.json');

  const root = tempDir('paboot-live-workspace-');
  const dataDir = tempDir('paboot-live-data-');
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.seedDefaultWorkspace(root, 'ask')!;
  db.createSession({
    id: 'session-live',
    runtime: 'builtin',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: root,
    model: 'deepseek:deepseek-flash',
  });
  const notifier = new RunNotifier();
  const permissions = new PermissionManager(5_000);
  const knowledge = new KnowledgeStore(dataDir);
  const attachments = new AttachmentStore(db, dataDir);
  const registry = createRegistry();
  const ctx = {
    config: {
      dataDir,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      agentToken: 'agent-token',
      serverToken: 'server-token',
      permissionMode: 'ask',
      runIdleTimeoutMs: 0,
    },
    db,
    knowledge,
    attachments,
    registry,
    permissions,
    notifier,
    hookPath: '/missing-hook.js',
    mcpServerPath: '/missing-mcp-server.js',
  } as unknown as AppContext;
  registry.registerDriver(createBuiltinDriver(ctx));
  return { ctx, db, root, attachments, workspace, sessionId: 'session-live' };
}

function sink(frames: SseFrame[]): RunSink {
  return {
    frame: (frame) => frames.push(frame),
  };
}

liveDescribe('live DeepSeek builtin driver', () => {
  it('runs text + Read against deepseek-flash', async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.root, 'hello.txt'), 'hello from deepseek live test\n');
    const frames: SseFrame[] = [];
    const session = h.db.getSession(h.sessionId)!;
    const workspace = h.db.getWorkspace(h.workspace.id)!;
    const handle = startSessionRun(h.ctx, {
      session,
      workspace,
      prompt: 'Use the Read tool to read hello.txt. Then reply with the exact file contents.',
      driver: h.ctx.registry.driver('builtin')!,
      permissionMode: 'ask',
      model: session.model,
      modelParameters: null,
      trigger: 'user',
      sink: sink(frames),
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('succeeded');
    expect(frames.some((frame) => frame.event.type === 'tool_use')).toBe(true);
    const text = frames
      .filter((frame) => frame.event.type === 'text_delta')
      .map((frame) => (frame.event.type === 'text_delta' ? frame.event.delta : ''))
      .join('');
    expect(text).toContain('hello from deepseek live test');
  }, 180_000);

  it('sends an image to deepseek-flash', async () => {
    const h = setup();
    const attachment = await h.attachments.saveImage(png1x1(), 'image/png');
    const frames: SseFrame[] = [];
    const session = h.db.getSession(h.sessionId)!;
    const workspace = h.db.getWorkspace(h.workspace.id)!;
    const handle = startSessionRun(h.ctx, {
      session,
      workspace,
      prompt: 'What color is this 1x1 image? Answer in one short word.',
      driver: h.ctx.registry.driver('builtin')!,
      permissionMode: 'ask',
      model: session.model,
      modelParameters: null,
      attachmentIds: [attachment.id],
      trigger: 'user',
      sink: sink(frames),
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('succeeded');
    const text = frames
      .filter((frame) => frame.event.type === 'text_delta')
      .map((frame) => (frame.event.type === 'text_delta' ? frame.event.delta : ''))
      .join('');
    expect(text.trim().length).toBeGreaterThan(0);
  }, 180_000);
});
