import type { McpTool } from '../../../types.js';

const SCHEDULE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'every_minutes', 'every_hours'] },
        time: { type: 'string', description: 'HH:MM, required for daily/weekdays/weekly' },
        days: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          description: 'Weekdays for weekly (0 = Sunday)',
        },
        every: { type: 'integer', description: 'N for every_minutes / every_hours' },
        timezone: { type: 'string', description: 'IANA zone; defaults to the daemon local zone' },
      },
      required: ['preset'],
    },
    {
      type: 'object',
      properties: {
        cron: { type: 'string', description: '5-field cron expression' },
        timezone: { type: 'string' },
      },
      required: ['cron'],
    },
  ],
} as const;

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['current', 'existing', 'new'],
      description:
        'current = this conversation; existing = another session in this workspace; new = create a session on the first fire',
    },
    sessionId: { type: 'string', description: 'Required for mode=existing. Get it from list_sessions.' },
    runtime: {
      type: 'string',
      description: 'For mode=new; defaults to the current session runtime',
    },
  },
  required: ['mode'],
} as const;

export const scheduleTaskTool: McpTool = {
  definition: {
    name: 'schedule_task',
    description:
      'Create a recurring task that runs unattended with full permissions. The user is warned in the client. Without a target it binds to the CURRENT session; use target.mode=existing (with a sessionId from list_sessions) or target.mode=new for other cases. Only call this after the user explicitly confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name shown in the client' },
        prompt: {
          type: 'string',
          description:
            "Execution prompt sent on every fire. Draft it from the user's goal and show it to them before confirming; do not ask the user to write it.",
        },
        schedule: SCHEDULE_SCHEMA,
        target: TARGET_SCHEMA,
      },
      required: ['name', 'prompt', 'schedule'],
    },
  },
  run(args, ctx) {
    return ctx.callDaemon('POST', '/api/internal/mcp/schedule-task', {
      runId: ctx.runId,
      name: args.name,
      prompt: args.prompt,
      schedule: args.schedule,
      target: args.target,
    });
  },
};
