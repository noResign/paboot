import type { AgentRunContext, ToolDescriptor } from '../types.js';

export interface ToolResult {
  content: string;
  isError: boolean;
  meta?: unknown;
  interrupted?: boolean;
}

export interface ToolCallRequest {
  /** Provider-issued call id from the assistant stream. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolProviderContext {
  agent: AgentRunContext;
  signal: AbortSignal;
}

export interface ToolCallContext extends ToolProviderContext {
  callId: string;
}

/** One tool implementation within a native provider. */
export interface ToolImplementation {
  descriptor: ToolDescriptor;
  call(input: unknown, context: ToolCallContext): Promise<ToolResult> | ToolResult;
}

/** Tool source seam. MCP and future delegate-agent sources implement this. */
export interface ToolProvider {
  id: string;
  list(context: ToolProviderContext): Promise<ToolDescriptor[]> | ToolDescriptor[];
  call(
    context: ToolCallContext,
    name: string,
    input: unknown,
  ): Promise<ToolResult> | ToolResult;
  close?(): Promise<void> | void;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(name: string) {
    super(`unknown tool: ${name}`, 'tool_not_found');
    this.name = 'ToolNotFoundError';
  }
}
