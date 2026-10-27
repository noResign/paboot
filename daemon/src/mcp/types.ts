/**
 * The contract between one MCP server and its tool implementations.
 *
 * A tool owns its schema and handler together; the server only knows how to
 * list definitions and dispatch calls.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Per-process context shared by every tool of one MCP server. */
export interface ToolContext {
  /** The run that spawned this MCP server (`PABOOT_RUN_ID`). */
  runId: string;
  callDaemon(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
}

export interface McpTool {
  definition: McpToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> | unknown;
}
