import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpPath = path.join(here, '../src/mcp-server.ts');
const tsxBin = path.join(here, '../node_modules/.bin/tsx');

interface JsonRpcResponse {
  id: number | string;
  result?: any;
  error?: { code: number; message: string };
}

interface Client {
  rpc(method: string, params?: unknown): Promise<JsonRpcResponse>;
  stop(): void;
}

const servers: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const fakeCalls: Array<{ method: string; path: string; body: any }> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  fakeCalls.splice(0);
});

async function fakeDaemon(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/api/internal/mcp/schedule-task', (req, res) => {
    fakeCalls.push({ method: 'POST', path: req.path, body: req.body });
    if (req.body?.name === 'blocked') {
      res.status(409).json({ error: 'a scheduled run cannot create another scheduled task', code: 'recursion_blocked' });
      return;
    }
    res.status(201).json({ ok: true, task: { id: 'task-1', name: req.body.name } });
  });
  app.get('/api/internal/mcp/scheduled-tasks', (req, res) => {
    fakeCalls.push({ method: 'GET', path: req.path, body: req.query });
    res.json({ tasks: [{ id: 'task-1' }] });
  });
  app.get('/api/internal/mcp/sessions', (req, res) => {
    fakeCalls.push({ method: 'GET', path: req.path, body: req.query });
    res.json({ currentSessionId: 'session-1', sessions: [{ id: 'session-1', title: 'main' }] });
  });
  app.post('/api/internal/mcp/scheduled-tasks/:id/cancel', (req, res) => {
    fakeCalls.push({ method: 'POST', path: req.path, body: req.body });
    res.json({ ok: true, id: req.params.id });
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function startClient(env: NodeJS.ProcessEnv): Client {
  const child = spawn(tsxBin, [mcpPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });

  let nextId = 1;
  return {
    rpc(method, params) {
      const id = nextId++;
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, 4000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    stop() {
      child.kill();
    },
  };
}

function daemonEnv(url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PABOOT_DAEMON_URL: url,
    PABOOT_TOKEN: 'test-token',
    PABOOT_RUN_ID: 'run-1',
  };
}

describe('paboot_tasks MCP server', () => {
  it('initializes and lists the task tools', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'paboot-tasks' },
    });

    const list = await client.rpc('tools/list');
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'schedule_task',
      'list_scheduled_tasks',
      'cancel_scheduled_task',
      'list_sessions',
    ]);
    client.stop();
  });

  it('creates, lists and cancels tasks through the daemon', async () => {
    const url = await fakeDaemon();
    const client = startClient(daemonEnv(url));

    const created = await client.rpc('tools/call', {
      name: 'schedule_task',
      arguments: {
        name: 'daily',
        prompt: 'summarize',
        schedule: { preset: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
        target: { mode: 'current' },
      },
    });
    expect(created.result.isError).toBeUndefined();
    expect(created.result.content[0].text).toContain('"id": "task-1"');
    expect(fakeCalls[0]).toMatchObject({
      method: 'POST',
      path: '/api/internal/mcp/schedule-task',
      body: { runId: 'run-1', name: 'daily', prompt: 'summarize', target: { mode: 'current' } },
    });

    const listed = await client.rpc('tools/call', { name: 'list_scheduled_tasks', arguments: {} });
    expect(listed.result.content[0].text).toContain('"id": "task-1"');
    expect(fakeCalls[1].body).toMatchObject({ runId: 'run-1' });

    const cancelled = await client.rpc('tools/call', {
      name: 'cancel_scheduled_task',
      arguments: { taskId: 'task-1' },
    });
    expect(cancelled.result.content[0].text).toContain('"id": "task-1"');
    expect(fakeCalls[2]).toMatchObject({
      method: 'POST',
      path: '/api/internal/mcp/scheduled-tasks/task-1/cancel',
      body: { runId: 'run-1' },
    });
    client.stop();
  });

  it('lists workspace sessions for target selection', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', { name: 'list_sessions', arguments: {} });
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content[0].text).toContain('"id": "session-1"');
    expect(fakeCalls[0]).toMatchObject({
      method: 'GET',
      path: '/api/internal/mcp/sessions',
      body: { runId: 'run-1' },
    });
    client.stop();
  });

  it('returns the daemon error as a tool error', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', {
      name: 'schedule_task',
      arguments: { name: 'blocked', prompt: 'x', schedule: { preset: 'daily', time: '09:00' } },
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('scheduled run cannot create');
    client.stop();
  });

  it('fails closed when the daemon env is missing', async () => {
    const env = { ...process.env };
    delete env.PABOOT_DAEMON_URL;
    delete env.PABOOT_TOKEN;
    delete env.PABOOT_RUN_ID;
    const client = startClient(env);
    const response = await client.rpc('tools/call', {
      name: 'list_scheduled_tasks',
      arguments: {},
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('not configured');
    client.stop();
  });
});
