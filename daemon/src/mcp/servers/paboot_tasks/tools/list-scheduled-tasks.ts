import type { McpTool } from '../../../types.js';

export const listScheduledTasksTool: McpTool = {
  definition: {
    name: 'list_scheduled_tasks',
    description:
      'List the scheduled tasks in the current workspace, across sessions. The result includes currentSessionId so tasks bound to this session can be identified.',
    inputSchema: { type: 'object', properties: {} },
  },
  run(_args, ctx) {
    return ctx.callDaemon(
      'GET',
      `/api/internal/mcp/scheduled-tasks?runId=${encodeURIComponent(ctx.runId)}`,
    );
  },
};
