import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunContext } from '../src/runtimes/builtin/types';
import { McpClient } from '../src/runtimes/builtin/mcp/client';
import { McpToolProvider, mcpToolName } from '../src/runtimes/builtin/mcp/provider';
import type { ToolServerSpec } from '../src/runtimes/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const taskServerPath = path.join(here, '../src/mcp/servers/paboot_tasks/server.ts');
const tsxBin = path.join(here, '../node_modules/.bin/tsx');

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const fakeMcpScript = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      instructions: 'Use the fake echo tool.'
    }});
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [{
      name: 'echo',
      description: 'Echo the arguments',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
    }] } });
    return;
  }
  if (message.method === 'tools/call') {
    send({ id: message.id, result: {
      content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }]
    } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: 'method not found' } });
});
`;

function fakeSpec(name = 'fake'): ToolServerSpec {
  return {
    name,
    command: process.execPath,
    args: ['-e', fakeMcpScript],
    env: {},
  };
}

function agent(root: string): AgentRunContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin' },
    workspace: { id: 'ws-1', name: 'Acme', family: 'dev', root },
    cwd: root,
    extraDirs: [],
    pathPolicy: { mode: 'server-strict', grants: [], denyRoots: [] },
    permissionMode: 'ask',
    signal: new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'denied' }) },
  };
}

describe('McpClient', () => {
  it('initializes, lists and calls tools', async () => {
    const client = new McpClient({ spec: fakeSpec(), requestTimeoutMs: 5_000 });
    try {
      await client.connect();
      expect(client.instructions).toContain('fake echo');
      const tools = await client.listTools();
      expect(tools).toEqual([
        {
          name: 'echo',
          description: 'Echo the arguments',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ]);
      await expect(client.callTool('echo', { text: 'hi' })).resolves.toEqual({
        content: '{"text":"hi"}',
        isError: false,
      });
    } finally {
      await client.close();
    }
  });
});

describe('McpToolProvider', () => {
  it('namespaces tools and routes calls through the MCP client', async () => {
    const provider = new McpToolProvider([fakeSpec('fake server')]);
    const context = { agent: agent(process.cwd()), signal: new AbortController().signal };
    try {
      const tools = await provider.list(context);
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'mcp__fake_server__echo',
        source: { kind: 'mcp', id: 'fake server' },
        sideEffect: 'mcp',
      });
      const result = await provider.call(
        { ...context, callId: 'call-1' },
        mcpToolName('fake server', 'echo'),
        { text: 'hello' },
      );
      expect(result).toEqual({ content: '{"text":"hello"}', isError: false });
    } finally {
      await provider.close();
    }
  });

  it('disables only the broken server and keeps healthy tools available', async () => {
    const provider = new McpToolProvider([
      { name: 'broken', command: '/definitely/missing/mcp-server', args: [], env: {} },
      fakeSpec('healthy'),
    ]);
    try {
      const tools = await provider.list({
        agent: agent(process.cwd()),
        signal: new AbortController().signal,
      });
      expect(tools.map((tool) => tool.name)).toEqual(['mcp__healthy__echo']);
    } finally {
      await provider.close();
    }
  });
});

describe('paboot_tasks MCP vertical slice', () => {
  it('lists and calls the real task server through the provider', async () => {
    const app = express();
    app.get('/api/internal/mcp/scheduled-tasks', (_req, res) => {
      res.json({ tasks: [{ id: 'task-1', name: 'daily' }] });
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const daemonUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const spec: ToolServerSpec = {
      name: 'paboot_tasks',
      command: tsxBin,
      args: [taskServerPath],
      env: {
        ...process.env,
        PABOOT_DAEMON_URL: daemonUrl,
        PABOOT_TOKEN: 'test-token',
        PABOOT_RUN_ID: 'run-1',
      } as Record<string, string>,
    };
    const provider = new McpToolProvider([spec], { requestTimeoutMs: 10_000 });
    try {
      const tools = await provider.list({
        agent: agent(process.cwd()),
        signal: new AbortController().signal,
      });
      expect(tools.map((tool) => tool.name)).toContain(
        'mcp__paboot_tasks__list_scheduled_tasks',
      );
      const result = await provider.call(
        { agent: agent(process.cwd()), signal: new AbortController().signal, callId: 'call-1' },
        'mcp__paboot_tasks__list_scheduled_tasks',
        {},
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain('"id": "task-1"');
    } finally {
      await provider.close();
    }
  }, 20_000);
});
