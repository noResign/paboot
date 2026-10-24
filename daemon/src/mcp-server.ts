#!/usr/bin/env node
/**
 * Minimal stdio MCP server exposed to every agent runtime as `paboot_tasks`.
 *
 * The agent can create a scheduled task bound to its *current* session, list
 * the session's tasks, and cancel one. The daemon resolves the session from
 * `PABOOT_RUN_ID`; the agent never supplies a session id.
 *
 * Only JSON-RPC frames go to stdout. Diagnostics go to stderr, and any
 * daemon/transport failure is returned as an MCP tool error (fail closed).
 */

const DAEMON_URL = process.env.PABOOT_DAEMON_URL ?? '';
const TOKEN = process.env.PABOOT_TOKEN ?? '';
const RUN_ID = process.env.PABOOT_RUN_ID ?? '';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'paboot-tasks';

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SCHEDULE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'every_minutes', 'every_hours'] },
        time: { type: 'string', description: 'HH:MM, required for daily/weekdays/weekly' },
        days: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          description: 'Weekdays for weekly (0 = Sunday)',
        },
        every: { type: 'integer', description: 'N for every_minutes / every_hours' },
        timezone: { type: 'string', description: 'IANA zone; defaults to the daemon local zone' },
      },
      required: ['preset'],
    },
    {
      type: 'object',
      properties: {
        cron: { type: 'string', description: '5-field cron expression' },
        timezone: { type: 'string' },
      },
      required: ['cron'],
    },
  ],
} as const;

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['current', 'existing', 'new'],
      description:
        'current = this conversation; existing = another session in this workspace; new = create a session on the first fire',
    },
    sessionId: { type: 'string', description: 'Required for mode=existing. Get it from list_sessions.' },
    runtime: {
      type: 'string',
      description: 'For mode=new; defaults to the current session runtime',
    },
  },
  required: ['mode'],
} as const;

const TOOLS: ToolDefinition[] = [
  {
    name: 'schedule_task',
    description:
      'Create a recurring task that runs unattended with full permissions. The user is warned in the client. Without a target it binds to the CURRENT session; use target.mode=existing (with a sessionId from list_sessions) or target.mode=new for other cases. Only call this after the user explicitly confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name shown in the client' },
        prompt: {
          type: 'string',
          description:
            "Execution prompt sent on every fire. Draft it from the user's goal and show it to them before confirming; do not ask the user to write it.",
        },
        schedule: SCHEDULE_SCHEMA,
        target: TARGET_SCHEMA,
      },
      required: ['name', 'prompt', 'schedule'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description: "List the scheduled tasks bound to the current session.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Delete a scheduled task bound to the current session.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'list_sessions',
    description:
      'List chat sessions in the current workspace (id, title, cwd, runtime). Use this to let the user pick target.mode=existing.',
    inputSchema: { type: 'object', properties: {} },
  },
];

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
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callDaemon(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  if (!DAEMON_URL || !TOKEN || !RUN_ID) {
    throw new Error('paboot task tool is not configured (missing PABOOT_DAEMON_URL/PABOOT_TOKEN/PABOOT_RUN_ID)');
  }
  const response = await fetch(`${DAEMON_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `daemon returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case 'schedule_task': {
        const result = await callDaemon('POST', '/api/internal/mcp/schedule-task', {
          runId: RUN_ID,
          name: args.name,
          prompt: args.prompt,
          schedule: args.schedule,
          target: args.target,
        });
        return toolResult(result);
      }
      case 'list_sessions': {
        const result = await callDaemon(
          'GET',
          `/api/internal/mcp/sessions?runId=${encodeURIComponent(RUN_ID)}`,
        );
        return toolResult(result);
      }
      case 'list_scheduled_tasks': {
        const result = await callDaemon(
          'GET',
          `/api/internal/mcp/scheduled-tasks?runId=${encodeURIComponent(RUN_ID)}`,
        );
        return toolResult(result);
      }
      case 'cancel_scheduled_task': {
        const taskId = typeof args.taskId === 'string' ? args.taskId : '';
        if (!taskId) throw new Error('taskId is required');
        const result = await callDaemon(
          'POST',
          `/api/internal/mcp/scheduled-tasks/${encodeURIComponent(taskId)}/cancel`,
          { runId: RUN_ID },
        );
        return toolResult(result);
      }
      default:
        return toolResult(`unknown tool: ${name}`, true);
    }
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
      });
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
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
