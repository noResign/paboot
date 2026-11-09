import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const memoryTimelineTool: McpTool = {
  definition: {
    name: 'memory_timeline',
    description:
      'Workspace-level timeline of recent observations and session summaries, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum items (default 50).' },
      },
    },
  },
  async run(args, ctx) {
    const params = new URLSearchParams(sessionQuery(ctx));
    if (typeof args.limit === 'number') params.set('limit', String(args.limit));
    return ctx.callDaemon('GET', `/api/internal/memory/timeline?${params.toString()}`);
  },
};
