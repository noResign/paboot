#!/usr/bin/env node
/**
 * Minimal stdio MCP server exposed to every agent runtime as `paboot_tasks`.
 *
 * The agent can create a scheduled task bound to its *current* session, and
 * list/cancel tasks across its *current workspace*. The daemon resolves the
 * session and workspace from `PABOOT_RUN_ID`; the agent never supplies either.
 *
 * Only JSON-RPC frames go to stdout. Diagnostics go to stderr, and any
 * daemon/transport failure is returned as an MCP tool error (fail closed).
 */
import { createToolContext } from '../../context.js';
import type { McpTool } from '../../types.js';
import { TOOLS, TOOLS_BY_NAME } from './tools/index.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'paboot_tasks';

/** Server-level MCP guidance, without touching the agent's own system prompt. */
const SERVER_INSTRUCTIONS =
  'Prefer paboot_tasks for scheduled tasks; do not use system cron/systemd timers or other scheduling mechanisms.';

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const toolContext = createToolContext();

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id: string | number, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const tool: McpTool | undefined = TOOLS_BY_NAME.get(name);
    if (!tool) return toolResult(`unknown tool: ${name}`, true);
    return toolResult(await tool.run(args, toolContext));
  } catch (err) {
    return toolResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function handleMessage(message: RpcMessage): Promise<void> {
  const id = message.id;
  if (id === undefined || id === null) return; // notification: no response
  const method = message.method ?? '';
  const params = (message.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
        instructions: SERVER_INSTRUCTIONS,
      });
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS.map((tool) => tool.definition) });
      return;
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      respond(id, await callTool(name, args));
      return;
    }
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
let queue: Promise<void> = Promise.resolve();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (err) {
      process.stderr.write(`paboot-mcp: unparseable message: ${String(err)}\n`);
      continue;
    }
    queue = queue.then(() => handleMessage(message)).catch((err) => {
      process.stderr.write(`paboot-mcp: handler error: ${String(err)}\n`);
    });
  }
});
