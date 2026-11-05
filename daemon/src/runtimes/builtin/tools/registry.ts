import type { ToolDescriptor } from '../types.js';
import type { ToolCallContext, ToolProvider, ToolProviderContext, ToolResult } from './types.js';
import { ToolNotFoundError } from './types.js';

/**
 * Merge and route all per-run tool sources. Provider tool names are final
 * names (MCP prefixes its own names), so collisions fail loudly instead of
 * silently picking one provider.
 */
export class ToolRegistry {
  private cachedTools: ToolDescriptor[] | null = null;
  private cachedRoutes: Map<string, ToolProvider> | null = null;

  constructor(private readonly providers: readonly ToolProvider[]) {}

  async list(context: ToolProviderContext): Promise<ToolDescriptor[]> {
    if (this.cachedTools) return this.cachedTools;
    const tools: ToolDescriptor[] = [];
    const routes = new Map<string, ToolProvider>();
    for (const provider of this.providers) {
      const declared = await provider.list(context);
      for (const tool of declared) {
        if (routes.has(tool.name)) {
          throw new Error(`duplicate tool name across providers: ${tool.name}`);
        }
        routes.set(tool.name, provider);
        tools.push(tool);
      }
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    this.cachedTools = tools;
    this.cachedRoutes = routes;
    return tools;
  }

  async get(context: ToolProviderContext, name: string): Promise<ToolDescriptor | undefined> {
    const tools = await this.list(context);
    return tools.find((tool) => tool.name === name);
  }

  async call(context: ToolCallContext, name: string, input: unknown): Promise<ToolResult> {
    await this.list(context);
    const provider = this.cachedRoutes?.get(name);
    if (!provider) throw new ToolNotFoundError(name);
    return provider.call(context, name, input);
  }

  async close(): Promise<void> {
    for (const provider of this.providers) {
      await provider.close?.();
    }
  }
}
