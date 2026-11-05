import { log } from '../../../platform/log.js';
import type { ToolServerSpec } from '../../types.js';
import type { ToolDescriptor } from '../types.js';
import type {
  ToolCallContext,
  ToolProvider,
  ToolProviderContext,
  ToolResult,
} from '../tools/types.js';
import { ToolNotFoundError } from '../tools/types.js';
import { McpClient } from './client.js';

interface McpRoute {
  client: McpClient;
  remoteName: string;
}

export interface McpToolProviderOptions {
  requestTimeoutMs?: number;
  /** Test seam; defaults to the real stdio client. */
  createClient?: (spec: ToolServerSpec, context: ToolProviderContext) => McpClient;
}

/**
 * Expose one or more stdio MCP servers as a single ToolProvider. Every model
 * tool is namespaced as `mcp__<server>__<tool>`. A server that fails to start
 * is disabled with a warning instead of failing the whole run.
 */
export class McpToolProvider implements ToolProvider {
  readonly id = 'mcp';
  private listPromise: Promise<ToolDescriptor[]> | null = null;
  private tools: ToolDescriptor[] = [];
  private routes = new Map<string, McpRoute>();
  private clients: McpClient[] = [];
  private closed = false;

  constructor(
    private readonly specs: readonly ToolServerSpec[],
    private readonly options: McpToolProviderOptions = {},
  ) {}

  list(context: ToolProviderContext): Promise<ToolDescriptor[]> {
    if (this.closed) return Promise.resolve([]);
    if (!this.listPromise) {
      this.listPromise = this.discover(context);
    }
    return this.listPromise;
  }

  async call(context: ToolCallContext, name: string, input: unknown): Promise<ToolResult> {
    await this.list(context);
    const route = this.routes.get(name);
    if (!route) throw new ToolNotFoundError(name);
    return route.client.callTool(route.remoteName, input);
  }

  async close(): Promise<void> {
    this.closed = true;
    const clients = this.clients.splice(0);
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    this.routes.clear();
    this.tools = [];
    this.listPromise = null;
  }

  private async discover(context: ToolProviderContext): Promise<ToolDescriptor[]> {
    const tools: ToolDescriptor[] = [];
    const routes = new Map<string, McpRoute>();
    for (const spec of this.specs) {
      const client =
        this.options.createClient?.(spec, context) ??
        new McpClient({
          spec,
          cwd: context.agent.cwd,
          requestTimeoutMs: this.options.requestTimeoutMs,
        });
      try {
        await client.connect();
        const declared = await client.listTools();
        const serverTools: ToolDescriptor[] = [];
        const serverRoutes = new Map<string, McpRoute>();
        for (const tool of declared) {
          const finalName = mcpToolName(spec.name, tool.name);
          if (routes.has(finalName) || serverRoutes.has(finalName)) {
            throw new Error(`duplicate MCP tool name: ${finalName}`);
          }
          serverRoutes.set(finalName, { client, remoteName: tool.name });
          serverTools.push({
            name: finalName,
            title: `${spec.name}/${tool.name}`,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: { kind: 'mcp', id: spec.name },
            sideEffect: 'mcp',
            concurrencySafe: false,
          });
        }
        // Commit only after the whole server listed cleanly, so a duplicate
        // cannot leave routes pointing at a process we just closed.
        this.clients.push(client);
        for (const [name, route] of serverRoutes) routes.set(name, route);
        tools.push(...serverTools);
      } catch (error) {
        await client.close().catch(() => undefined);
        log.warn(
          `builtin MCP server ${spec.name} disabled: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    this.tools = tools;
    this.routes = routes;
    return tools;
  }
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${safeSegment(serverName)}__${safeSegment(toolName)}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}
