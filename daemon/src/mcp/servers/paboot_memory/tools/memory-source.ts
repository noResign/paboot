import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const memorySourceTool: McpTool = {
  definition: {
    name: 'memory_source',
    description: 'Fetch the original L0 source text behind a claim or observation.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Source id from a memory/search hit.' },
      },
      required: ['sourceId'],
    },
  },
  async run(args, ctx) {
    const sourceId = typeof args.sourceId === 'string' ? args.sourceId : '';
    if (!sourceId) throw new Error('sourceId is required');
    return ctx.callDaemon(
      'GET',
      `/api/memory/sources/${encodeURIComponent(sourceId)}?${sessionQuery(ctx)}`,
    );
  },
};
