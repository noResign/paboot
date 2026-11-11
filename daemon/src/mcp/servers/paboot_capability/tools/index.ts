import type { McpTool } from '../../../types.js';
import { DEVICE_TOOLS } from './device.js';
import { echoTool } from './echo.js';
import { endListTool } from './end-list.js';

export const TOOLS: McpTool[] = [echoTool, endListTool, ...DEVICE_TOOLS];
