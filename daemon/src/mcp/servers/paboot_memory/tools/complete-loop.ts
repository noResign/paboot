import { requireToolPermission } from '../../../gate.js';
import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const completeLoopTool: McpTool = {
  definition: {
    name: 'complete_loop',
    description: 'Mark an open follow-up as done. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        loopId: { type: 'string', description: 'Loop id from list_open_loops.' },
      },
      required: ['loopId'],
    },
  },
  async run(args, ctx) {
    const loopId = typeof args.loopId === 'string' ? args.loopId : '';
    if (!loopId) throw new Error('loopId is required');
    await requireToolPermission(ctx, 'mcp__paboot_memory__complete_loop', args);
    const params = new URLSearchParams(sessionQuery(ctx));
    return ctx.callDaemon(
      'POST',
      `/api/internal/memory/loops/${encodeURIComponent(loopId)}/complete?${params.toString()}`,
    );
  },
};
