import { requireToolPermission } from '../../../gate.js';
import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const forgetTool: McpTool = {
  definition: {
    name: 'forget',
    description:
      'Forget one claim. This is destructive and always asks the operator for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'string', description: 'Claim id from search_memory.' },
      },
      required: ['claimId'],
    },
  },
  async run(args, ctx) {
    const claimId = typeof args.claimId === 'string' ? args.claimId : '';
    if (!claimId) throw new Error('claimId is required');
    await requireToolPermission(ctx, 'mcp__paboot_memory__forget', args);
    const params = new URLSearchParams(sessionQuery(ctx));
    return ctx.callDaemon('POST', `/api/internal/memory/forget?${params.toString()}`, { claimId });
  },
};
