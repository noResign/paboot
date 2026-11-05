import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { getActiveRun } from '../src/runtimes/active-runs';
import { createBuiltinDriver } from '../src/runtimes/builtin/driver';
import { createRegistry } from '../src/runtimes/registry';
import type { SseFrame } from '../src/types/api';

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

function tempDir(prefix = 'paboot-builtin-driver-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function pngBytes(): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

interface FakeProvider {
  url: string;
  requests: Array<Record<string, unknown>>;
  requestCount: number;
}

async function fakeProvider(responder: (request: Record<string, unknown>, index: number, res: http.ServerResponse) => void): Promise<FakeProvider> {
  const state: FakeProvider = { url: '', requests: [], requestCount: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      state.requestCount += 1;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      state.requests.push(parsed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      responder(parsed, state.requestCount, res);
    });
  });
  servers.push(server);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function sse(res: http.ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function finishText(res: http.ServerResponse, text: string): void {
  sse(res, { choices: [{ delta: { content: text }, finish_reason: null }] });
  sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  sse(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function fakeToolCall(res: http.ServerResponse): void {
  sse(res, {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_read',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"hello.txt"}' },
        }],
      },
      finish_reason: null,
    }],
  });
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  sse(res, { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

interface Harness {
  ctx: AppContext;
  db: Db;
  store: AttachmentStore;
  workspaceId: string;
  sessionId: string;
  root: string;
}

function harness(): Harness {
  const root = tempDir('paboot-builtin-workspace-');
  const dataDir = tempDir('paboot-builtin-data-');
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.seedDefaultWorkspace(root, 'ask');
  if (!workspace) throw new Error('workspace not created');
  const session = db.createSession({
    id: 'session-1',
    runtime: 'builtin',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: root,
    model: 'fake:fake-model',
  });
  const notifier = new RunNotifier();
  const permissions = new PermissionManager(1_000);
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
  return { ctx, db, store: attachments, workspaceId: workspace.id, sessionId: session.id, root };
}

function sinkFrames(frames: SseFrame[], onFrame?: (frame: SseFrame) => void): RunSink {
  return {
    begin: () => undefined,
    frame: (frame) => {
      frames.push(frame);
      onFrame?.(frame);
    },
    end: () => undefined,
  };
}

async function start(h: Harness, options: {
  prompt: string;
  model?: string | null;
  attachmentIds?: string[];
  frames: SseFrame[];
  onFrame?: (frame: SseFrame) => void;
}) {
  const session = h.db.getSession(h.sessionId)!;
  const workspace = h.db.getWorkspace(h.workspaceId)!;
  const driver = h.ctx.registry.driver('builtin')!;
  return startSessionRun(h.ctx, {
    session,
    workspace,
    prompt: options.prompt,
    driver,
    permissionMode: 'ask',
    model: options.model === undefined ? session.model : options.model,
    modelParameters: null,
    attachmentIds: options.attachmentIds,
    trigger: 'user',
    sink: sinkFrames(options.frames, options.onFrame),
  });
}

describe('builtin driver E2E with fake provider', () => {
  it('runs text -> Read tool -> tool result -> final text and persists transcript', async () => {
    const provider = await fakeProvider((_body, index, res) => {
      if (index === 1) fakeToolCall(res);
      else finishText(res, 'The file says hello from the file.');
    });
    setEnv('PABOOT_LLM_PROVIDERS', JSON.stringify({
      providers: [{
        id: 'fake',
        kind: 'openai',
        baseUrl: provider.url,
        apiKey: 'fake-key',
        models: [{ id: 'fake-model', supportsTools: true, supportsImages: true }],
      }],
    }));
    setEnv('PABOOT_LLM_PROVIDERS_FILE', path.join(tempDir('paboot-builtin-empty-'), 'missing.json'));

    const h = harness();
    fs.writeFileSync(path.join(h.root, 'hello.txt'), 'hello from the file\n');
    const frames: SseFrame[] = [];
    const handle = await start(h, { prompt: 'Read hello.txt', frames });
    const outcome = await handle.done;

    expect(outcome).toMatchObject({ status: 'succeeded', error: null });
    expect(provider.requestCount).toBe(2);
    const eventTypes = frames.map((frame) => frame.event.type);
    expect(eventTypes).toContain('text_delta');
    expect(eventTypes).toContain('tool_use');
    expect(eventTypes).toContain('tool_result');
    expect(eventTypes).toContain('turn_end');
    expect(frames.find((frame) => frame.event.type === 'tool_result')?.event).toMatchObject({
      toolUseId: 'call_read',
      isError: false,
    });
    expect(JSON.stringify(frames.find((frame) => frame.event.type === 'tool_result')?.event)).toContain(
      'hello from the file',
    );

    const second = provider.requests[1] as { messages: Array<Record<string, unknown>> };
    expect(JSON.stringify(second.messages)).toContain('hello from the file');
    expect((h.db.getRun(handle.runId)?.status)).toBe('succeeded');

    const thread = h.db.getNativeThreadForSession(h.sessionId, 'builtin');
    const messages = h.db.listNativeMessages(thread!.id);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(messages.some((message) => message.source.kind === 'runtime-context')).toBe(true);
    expect(messages[2]?.blocks).toContainEqual(
      expect.objectContaining({ type: 'tool_call', name: 'Read', id: 'call_read' }),
    );
    expect(messages[3]?.blocks).toContainEqual(
      expect.objectContaining({ type: 'tool_result', toolUseId: 'call_read' }),
    );
  });

  it('reconstructs earlier turns from the durable transcript on the next run', async () => {
    let call = 0;
    const provider = await fakeProvider((_body, _index, res) => {
      call += 1;
      finishText(res, call === 1 ? 'first answer' : 'second answer');
    });
    setEnv('PABOOT_LLM_PROVIDERS', JSON.stringify({
      providers: [{
        id: 'fake',
        kind: 'openai',
        baseUrl: provider.url,
        apiKey: 'fake-key',
        models: [{ id: 'fake-model', supportsTools: true, supportsImages: true }],
      }],
    }));
    setEnv('PABOOT_LLM_PROVIDERS_FILE', path.join(tempDir('paboot-builtin-empty-'), 'missing.json'));

    const h = harness();
    const firstFrames: SseFrame[] = [];
    await (await start(h, { prompt: 'first prompt', frames: firstFrames })).done;
    const secondFrames: SseFrame[] = [];
    const second = await start(h, { prompt: 'second prompt', frames: secondFrames });
    await second.done;

    const secondRequest = provider.requests[1] as { messages: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(secondRequest.messages);
    expect(serialized).toContain('first prompt');
    expect(serialized).toContain('first answer');
    expect(serialized).toContain('second prompt');
    expect(secondFrames.some(
      (frame) => frame.event.type === 'text_delta' && frame.event.delta === 'second answer',
    )).toBe(true);
  });

  it('sends image refs to a vision model and binds the attachment', async () => {
    const provider = await fakeProvider((_body, _index, res) => {
      finishText(res, 'I can see the image.');
    });
    setEnv('PABOOT_LLM_PROVIDERS', JSON.stringify({
      providers: [{
        id: 'fake',
        kind: 'openai',
        baseUrl: provider.url,
        apiKey: 'fake-key',
        models: [{ id: 'fake-model', supportsTools: true, supportsImages: true }],
      }],
    }));
    setEnv('PABOOT_LLM_PROVIDERS_FILE', path.join(tempDir('paboot-builtin-empty-'), 'missing.json'));

    const h = harness();
    const attachment = await h.store.saveImage(pngBytes(), 'image/png');
    const frames: SseFrame[] = [];
    const handle = await start(h, {
      prompt: 'What is in this image?',
      attachmentIds: [attachment.id],
      frames,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('succeeded');
    const first = provider.requests[0] as { messages: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(first.messages);
    expect(serialized).toContain('"type":"image_url"');
    expect(serialized).toContain('data:image/png;base64,');
    expect(h.store.get(attachment.id)).toMatchObject({
      sessionId: h.sessionId,
      workspaceId: h.workspaceId,
    });
  });

  it('cancels a live stream and ends the run without a hanging tool call', async () => {
    const provider = await fakeProvider((_body, _index, res) => {
      sse(res, { choices: [{ delta: { content: 'partial output' }, finish_reason: null }] });
      // Keep the response open until the client aborts.
      res.on('close', () => res.end());
    });
    setEnv('PABOOT_LLM_PROVIDERS', JSON.stringify({
      providers: [{
        id: 'fake',
        kind: 'openai',
        baseUrl: provider.url,
        apiKey: 'fake-key',
        models: [{ id: 'fake-model', supportsTools: true, supportsImages: true }],
      }],
    }));
    setEnv('PABOOT_LLM_PROVIDERS_FILE', path.join(tempDir('paboot-builtin-empty-'), 'missing.json'));

    const h = harness();
    const frames: SseFrame[] = [];
    let handle: Awaited<ReturnType<typeof start>> | null = null;
    let cancelled = false;
    handle = await start(h, {
      prompt: 'Stream until cancelled',
      frames,
      onFrame: (frame) => {
        if (!cancelled && frame.event.type === 'text_delta') {
          cancelled = true;
          getActiveRun(handle!.runId)?.cancel('test cancel');
        }
      },
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('cancelled');
    expect(h.db.getRun(handle.runId)?.status).toBe('cancelled');
    expect(frames.some((frame) => frame.event.type === 'tool_use')).toBe(false);
    expect(frames.some(
      (frame) => frame.event.type === 'turn_end' && frame.event.stopReason === 'cancelled',
    )).toBe(true);
    expect(provider.requestCount).toBe(1);
  });
});
