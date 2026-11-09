import type { McpTool } from '../../../types.js';
import { listOpenLoopsTool } from './list-open-loops.js';
import { memorySourceTool } from './memory-source.js';
import { memoryTimelineTool } from './memory-timeline.js';
import { searchMemoryTool } from './search-memory.js';

export const TOOLS: McpTool[] = [
  searchMemoryTool,
  memoryTimelineTool,
  memorySourceTool,
  listOpenLoopsTool,
];
