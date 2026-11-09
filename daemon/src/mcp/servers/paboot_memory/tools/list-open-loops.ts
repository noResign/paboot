import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const listOpenLoopsTool: McpTool = {
  definition: {
    name: 'list_open_loops',
    description: 'List unfinished follow-ups recorded for the current workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(_args, ctx) {
    return ctx.callDaemon('GET', `/api/internal/memory/loops?${sessionQuery(ctx)}`);
  },
};
