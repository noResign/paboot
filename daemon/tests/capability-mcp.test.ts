import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '../src/mcp/servers/paboot_capability/server.ts');
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
const calls: Array<{ method: string; path: string; body: any }> = [];
let permissionStatus: 'allowed' | 'denied' | 'timed_out' = 'allowed';

afterEach(async () => {
  permissionStatus = 'allowed';
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  calls.splice(0);
});

async function fakeDaemon(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/api/internal/permissions/create', (req, res) => {
    calls.push({ method: 'POST', path: req.path, body: req.body });
    res.json({ id: 'permission-1', status: 'pending' });
  });
  app.get('/api/internal/permissions/:id/status', (req, res) => {
    calls.push({ method: 'GET', path: req.path, body: null });
    res.json({ status: permissionStatus });
  });
  app.post('/api/internal/capability/device/:action', (req, res) => {
    calls.push({ method: 'POST', path: req.path, body: req.body });
    if (req.params.action === 'screenshot') {
      res.json({
        serial: 's',
        mimeType: 'image/png',
        width: 1,
        height: 2,
        png: Buffer.from('png').toString('base64'),
      });
      return;
    }
    res.json({ ok: true });
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function startClient(env: NodeJS.ProcessEnv): Client {
  const child = spawn(tsxBin, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

function daemonEnv(url: string, runtime?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PABOOT_DAEMON_URL: url,
    PABOOT_TOKEN: 'test-token',
    PABOOT_RUN_ID: 'run-1',
    ...(runtime === undefined ? {} : { PABOOT_RUNTIME: runtime }),
  };
}

describe('paboot_capability MCP server', () => {
  it('initializes and lists the stub tool', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'paboot_capability' },
    });
    const list = await client.rpc('tools/list');
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('echo');
    expect(names).toContain('android_device_list');
    expect(names).toContain('android_screenshot');
    expect(names).toContain('end_list');
    expect(names).toHaveLength(12);
    client.stop();
  });

  it('returns an image content block for screenshots', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', {
      name: 'android_screenshot',
      arguments: {},
    });
    expect(response.result.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect(calls.some((call) => call.path === '/api/internal/capability/device/screenshot')).toBe(
      true,
    );
    client.stop();
  });

  it('does not execute a device mutation when approval is denied', async () => {
    permissionStatus = 'denied';
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', {
      name: 'android_tap',
      arguments: { x: 1, y: 2 },
    });
    expect(response.result.isError).toBe(true);
    expect(calls.some((call) => call.path === '/api/internal/capability/device/tap')).toBe(false);
    client.stop();
  });

  it('dispatches an approved device mutation with the run id', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', {
      name: 'android_tap',
      arguments: { x: 1, y: 2 },
    });
    expect(response.result.isError).toBeUndefined();
    const call = calls.find((item) => item.path === '/api/internal/capability/device/tap');
    expect(call?.body).toMatchObject({ runId: 'run-1', x: 1, y: 2 });
    client.stop();
  });

  it('gates the tool through the internal permission API', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content[0].text).toContain('"echoed": "hi"');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/internal/permissions/create',
      body: {
        runId: 'run-1',
        toolName: 'mcp__paboot_capability__echo',
        toolInput: { text: 'hi' },
      },
    });
    expect(calls[1]).toMatchObject({
      method: 'GET',
      path: '/api/internal/permissions/permission-1/status',
    });
    client.stop();
  });

  it('denies the tool when the operator rejects it', async () => {
    permissionStatus = 'denied';
    const client = startClient(daemonEnv(await fakeDaemon()));
    const response = await client.rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('denied');
    client.stop();
  });

  it('skips the internal gate for the builtin runtime', async () => {
    const client = startClient(daemonEnv(await fakeDaemon(), 'builtin'));
    const response = await client.rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content[0].text).toContain('"echoed": "hi"');
    expect(calls).toEqual([]);
    client.stop();
  });

  it('fails closed when the daemon env is missing', async () => {
    const env = { ...process.env };
    delete env.PABOOT_DAEMON_URL;
    delete env.PABOOT_TOKEN;
    delete env.PABOOT_RUN_ID;
    const client = startClient(env);
    const response = await client.rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('not configured');
    client.stop();
  });
});
