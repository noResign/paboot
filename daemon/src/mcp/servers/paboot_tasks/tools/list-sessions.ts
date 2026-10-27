import type { McpTool } from '../../../types.js';

export const listSessionsTool: McpTool = {
  definition: {
    name: 'list_sessions',
    description:
      'List chat sessions in the current workspace (id, title, cwd, runtime). Use this to let the user pick target.mode=existing.',
    inputSchema: { type: 'object', properties: {} },
  },
  run(_args, ctx) {
    return ctx.callDaemon('GET', `/api/internal/mcp/sessions?runId=${encodeURIComponent(ctx.runId)}`);
  },
};
