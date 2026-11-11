import type { McpTool } from '../../../types.js';
import type { CapabilityScopeDto } from '../../../../types/api.js';

/**
 * Read-only discovery of the session's ends. The prompt only carries a compact
 * index; this tool returns the full list (and full notes for one end) on demand.
 */
export const endListTool: McpTool = {
  definition: {
    name: 'end_list',
    description:
      'List the ends available to this session, their enabled capabilities and summaries. Pass endId to read one end in full (including notes).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Filter by end kind (android, ios, web, api, data…).' },
        endId: { type: 'string', description: 'Return full details for one end.' },
      },
    },
  },
  async run(args, ctx) {
    const scope = (await ctx.callDaemon(
      'GET',
      `/api/internal/mcp/capability/scope?runId=${encodeURIComponent(ctx.runId)}`,
    )) as CapabilityScopeDto;
    if (typeof args.endId === 'string' && args.endId) {
      const end = scope.ends.find((item) => item.id === args.endId);
      if (!end) return { error: 'end_not_found', endId: args.endId };
      return { end };
    }
    const kind = typeof args.kind === 'string' && args.kind ? args.kind : null;
    return {
      primaryEndId: scope.endId,
      ends: kind ? scope.ends.filter((item) => item.kind === kind) : scope.ends,
    };
  },
};
