import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '../src/mcp/servers/paboot_memory/server.ts');
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
const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  calls.splice(0);
});

async function fakeDaemon(): Promise<string> {
  const app = express();
  app.get('/api/memory/search', (req, res) => {
    calls.push({ method: 'GET', path: req.path, query: req.query });
    res.json({ hits: [{ kind: 'claim', id: 'c1', title: '住在上海' }] });
  });
  app.get('/api/memory/timeline', (req, res) => {
    calls.push({ method: 'GET', path: req.path, query: req.query });
    res.json({ items: [{ kind: 'observation', id: 'o1', title: '修复登录页' }] });
  });
  app.get('/api/memory/sources/:id', (req, res) => {
    calls.push({ method: 'GET', path: req.path, query: req.query });
    res.json({ source: { id: req.params.id, content: '我搬到上海了' } });
  });
  app.get('/api/memory/loops', (req, res) => {
    calls.push({ method: 'GET', path: req.path, query: req.query });
    res.json({ loops: [{ id: 'l1', title: '补测试' }] });
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

function daemonEnv(url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PABOOT_DAEMON_URL: url,
    PABOOT_TOKEN: 'agent-token',
    PABOOT_RUN_ID: 'run-1',
    PABOOT_SESSION_ID: 'session-1',
  };
}

describe('paboot_memory MCP server', () => {
  it('lists the read-only memory tools', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result.serverInfo).toMatchObject({ name: 'paboot_memory' });
    const list = await client.rpc('tools/list');
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search_memory',
      'memory_timeline',
      'memory_source',
      'list_open_loops',
    ]);
    client.stop();
  });

  it('scopes every call to the session and returns daemon data', async () => {
    const client = startClient(daemonEnv(await fakeDaemon()));
    const search = await client.rpc('tools/call', {
      name: 'search_memory',
      arguments: { query: '上海' },
    });
    expect(search.result.content[0].text).toContain('住在上海');
    expect(calls[0]).toMatchObject({
      path: '/api/memory/search',
      query: { sessionId: 'session-1', q: '上海' },
    });

    const source = await client.rpc('tools/call', {
      name: 'memory_source',
      arguments: { sourceId: 's1' },
    });
    expect(source.result.content[0].text).toContain('我搬到上海了');
    expect(calls[1]).toMatchObject({
      path: '/api/memory/sources/s1',
      query: { sessionId: 'session-1' },
    });

    const loops = await client.rpc('tools/call', {
      name: 'list_open_loops',
      arguments: {},
    });
    expect(loops.result.content[0].text).toContain('补测试');
    client.stop();
  });

  it('fails closed without a session id', async () => {
    const env = daemonEnv(await fakeDaemon());
    delete env.PABOOT_SESSION_ID;
    const client = startClient(env);
    const response = await client.rpc('tools/call', {
      name: 'search_memory',
      arguments: { query: '上海' },
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('PABOOT_SESSION_ID');
    client.stop();
  });
});
