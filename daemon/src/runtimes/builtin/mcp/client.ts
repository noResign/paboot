import { StdioRpcError, spawnStdioRpc, type StdioRpcConnection } from '../../stdio-rpc.js';
import type { ToolServerSpec } from '../../types.js';
import type { ToolResult } from '../tools/types.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientOptions {
  spec: ToolServerSpec;
  cwd?: string;
  protocolVersion?: string;
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly code: 'spawn' | 'protocol' | 'tool_call' | 'closed',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

/**
 * Minimal MCP stdio client: initialize -> notifications/initialized ->
 * tools/list / tools/call. It intentionally does not implement MCP resources,
 * prompts, sampling or server-initiated requests; those can be added without
 * changing the ToolProvider adapter.
 */
export class McpClient {
  readonly name: string;
  private connection: StdioRpcConnection | null = null;
  private connectPromise: Promise<void> | null = null;
  private closed = false;
  private serverInstructions: string | undefined;

  constructor(private readonly options: McpClientOptions) {
    this.name = options.spec.name;
  }

  get instructions(): string | undefined {
    return this.serverInstructions;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new McpClientError('client is closed', 'closed');
    if (!this.connectPromise) {
      this.connectPromise = this.initialize().catch((error: unknown) => {
        this.connectPromise = null;
        void this.close();
        throw error;
      });
    }
    return this.connectPromise;
  }

  private async initialize(): Promise<void> {
    try {
      this.connection = spawnStdioRpc({
        command: this.options.spec.command,
        args: this.options.spec.args,
        cwd: this.options.cwd,
        env: this.options.spec.env,
        label: `mcp:${this.name}`,
        requestTimeoutMs: this.options.requestTimeoutMs ?? 20_000,
      });
    } catch (error) {
      throw new McpClientError(`failed to spawn MCP server ${this.name}`, 'spawn', error);
    }

    try {
      const result = await this.connection.request('initialize', {
        protocolVersion: this.options.protocolVersion ?? '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: this.options.clientName ?? 'paboot-builtin',
          version: this.options.clientVersion ?? '1.0.0',
        },
      });
      const record = asRecord(result);
      if (!record) throw new Error('initialize result is not an object');
      this.serverInstructions =
        typeof record['instructions'] === 'string' ? record['instructions'] : undefined;
      this.connection.notify('notifications/initialized', {});
    } catch (error) {
      throw new McpClientError(`failed to initialize MCP server ${this.name}`, 'protocol', error);
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.connect();
    const connection = this.requireConnection();
    try {
      const result = await connection.request('tools/list', {});
      const record = asRecord(result);
      const tools = Array.isArray(record?.['tools']) ? record['tools'] : [];
      return tools.map((raw, index) => parseToolDefinition(raw, index));
    } catch (error) {
      throw new McpClientError(`failed to list tools from MCP server ${this.name}`, 'protocol', error);
    }
  }

  async callTool(name: string, input: unknown): Promise<ToolResult> {
    await this.connect();
    const connection = this.requireConnection();
    try {
      const result = await connection.request('tools/call', {
        name,
        arguments: isRecord(input) ? input : {},
      });
      return parseToolResult(result);
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      const message = error instanceof StdioRpcError ? error.message : String(error);
      return { content: `MCP tool ${name} failed: ${message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.close();
  }

  private requireConnection(): StdioRpcConnection {
    if (!this.connection) throw new McpClientError(`MCP server ${this.name} is not connected`, 'closed');
    return this.connection;
  }
}

export function parseToolDefinition(raw: unknown, index: number): McpToolDefinition {
  const record = asRecord(raw);
  if (!record) throw new McpClientError(`MCP tool #${index + 1} is not an object`, 'protocol');
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!name) throw new McpClientError(`MCP tool #${index + 1} has no name`, 'protocol');
  const description = typeof record['description'] === 'string' ? record['description'] : name;
  const inputSchema = asRecord(record['inputSchema']) ?? { type: 'object', properties: {} };
  return { name, description, inputSchema };
}

export function parseToolResult(raw: unknown): ToolResult {
  const record = asRecord(raw);
  if (!record) return { content: 'MCP returned an invalid tool result', isError: true };
  const parts: string[] = [];
  if (Array.isArray(record['content'])) {
    for (const block of record['content']) {
      const item = asRecord(block);
      if (!item) continue;
      if (item['type'] === 'text' && typeof item['text'] === 'string') {
        parts.push(item['text']);
      } else if (item['type'] === 'image') {
        parts.push('[image omitted: builtin runtime cannot render images]');
      } else {
        parts.push(JSON.stringify(item));
      }
    }
  }
  if (parts.length === 0 && record['structuredContent'] !== undefined) {
    parts.push(JSON.stringify(record['structuredContent'], null, 2));
  }
  return {
    content: parts.join('\n'),
    isError: record['isError'] === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}
