import { requireToolPermission } from '../../../gate.js';
import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const rememberTool: McpTool = {
  definition: {
    name: 'remember',
    description:
      'Ask the operator to remember a piece of text in the current workspace. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact or note to remember.' },
      },
      required: ['text'],
    },
  },
  async run(args, ctx) {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) throw new Error('text is required');
    await requireToolPermission(ctx, 'mcp__paboot_memory__remember', args);
    const params = new URLSearchParams(sessionQuery(ctx));
    return ctx.callDaemon('POST', `/api/internal/memory/remember?${params.toString()}`, { text });
  },
};
