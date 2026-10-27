import type { McpTool } from '../../../types.js';

export const cancelScheduledTaskTool: McpTool = {
  definition: {
    name: 'cancel_scheduled_task',
    description: 'Delete a scheduled task in the current workspace.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  run(args, ctx) {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    if (!taskId) throw new Error('taskId is required');
    return ctx.callDaemon(
      'POST',
      `/api/internal/mcp/scheduled-tasks/${encodeURIComponent(taskId)}/cancel`,
      { runId: ctx.runId },
    );
  },
};
