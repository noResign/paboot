/**
 * Generic stdio MCP server loop. Each server owns its tool catalogue; this
 * module owns the JSON-RPC framing, initialization and dispatch so the
 * `paboot_tasks` / `paboot_capability` entries stay declarative.
 *
 * Only JSON-RPC frames go to stdout. Diagnostics go to stderr, and any
 * daemon/transport failure is returned as an MCP tool error (fail closed).
 */
import { createToolContext } from './context.js';
import type { McpTool, McpToolResult } from './types.js';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

export interface StdioMcpServerOptions {
  name: string;
  version?: string;
  instructions?: string;
  tools: readonly McpTool[];
  env?: NodeJS.ProcessEnv;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export function serveStdioMcp(options: StdioMcpServerOptions): void {
  const toolContext = createToolContext(options.env ?? process.env);
  const toolsByName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));

  const write = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const respond = (id: string | number, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result });
  };
  const respondError = (id: string | number, code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const toolResult = (value: unknown, isError = false): Record<string, unknown> => {
    const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
    return {
      content: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {}),
    };
  };

  const isToolResult = (value: unknown): value is McpToolResult => {
    if (!value || typeof value !== 'object') return false;
    const content = (value as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.every((block) => {
      if (!block || typeof block !== 'object') return false;
      const type = (block as { type?: unknown }).type;
      return type === 'text' || type === 'image';
    });
  };

  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const tool = toolsByName.get(name);
      if (!tool) return toolResult(`unknown tool: ${name}`, true);
      const value = await tool.run(args, toolContext);
      return isToolResult(value) ? value : toolResult(value);
    } catch (err) {
      return toolResult(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleMessage = async (message: RpcMessage): Promise<void> => {
    const id = message.id;
    if (id === undefined || id === null) return; // notification: no response
    const method = message.method ?? '';
    const params = (message.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion:
            typeof params.protocolVersion === 'string'
              ? params.protocolVersion
              : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: options.name, version: options.version ?? '1.0.0' },
          ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        });
        return;
      case 'ping':
        respond(id, {});
        return;
      case 'tools/list':
        respond(id, { tools: options.tools.map((tool) => tool.definition) });
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
  };

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
        process.stderr.write(`${options.name}: unparseable message: ${String(err)}\n`);
        continue;
      }
      queue = queue.then(() => handleMessage(message)).catch((err) => {
        process.stderr.write(`${options.name}: handler error: ${String(err)}\n`);
      });
    }
  });
}
