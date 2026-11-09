import type { McpTool } from '../../../types.js';
import { completeLoopTool } from './complete-loop.js';
import { forgetTool } from './forget.js';
import { listOpenLoopsTool } from './list-open-loops.js';
import { memorySourceTool } from './memory-source.js';
import { memoryTimelineTool } from './memory-timeline.js';
import { rememberTool } from './remember.js';
import { searchMemoryTool } from './search-memory.js';

export const TOOLS: McpTool[] = [
  searchMemoryTool,
  memoryTimelineTool,
  memorySourceTool,
  listOpenLoopsTool,
  rememberTool,
  forgetTool,
  completeLoopTool,
];
