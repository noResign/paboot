import type { McpTool } from '../../../types.js';
import { cancelScheduledTaskTool } from './cancel-scheduled-task.js';
import { listScheduledTasksTool } from './list-scheduled-tasks.js';
import { listSessionsTool } from './list-sessions.js';
import { scheduleTaskTool } from './schedule-task.js';

export const TOOLS: McpTool[] = [
  scheduleTaskTool,
  listScheduledTasksTool,
  cancelScheduledTaskTool,
  listSessionsTool,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));
