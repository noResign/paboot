import type { ToolDescriptor } from '../types.js';
import type {
  ToolCallContext,
  ToolImplementation,
  ToolProvider,
  ToolProviderContext,
  ToolResult,
} from './types.js';
import { ToolNotFoundError } from './types.js';

/**
 * In-process native tools. The provider intentionally does no approval or
 * path policy itself; the executor owns those cross-cutting rules.
 */
export class NativeToolProvider implements ToolProvider {
  readonly id = 'native';
  private readonly byName: Map<string, ToolImplementation>;

  constructor(tools: readonly ToolImplementation[]) {
    this.byName = new Map();
    for (const tool of tools) {
      if (this.byName.has(tool.descriptor.name)) {
        throw new Error(`duplicate native tool: ${tool.descriptor.name}`);
      }
      this.byName.set(tool.descriptor.name, tool);
    }
  }

  list(_context: ToolProviderContext): ToolDescriptor[] {
    return [...this.byName.values()].map((tool) => tool.descriptor);
  }

  call(context: ToolCallContext, name: string, input: unknown): Promise<ToolResult> | ToolResult {
    const tool = this.byName.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool.call(input, context);
  }
}
