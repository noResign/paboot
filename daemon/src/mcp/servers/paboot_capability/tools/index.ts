import type { McpTool } from '../../../types.js';
import { DEVICE_TOOLS } from './device.js';
import { echoTool } from './echo.js';

export const TOOLS: McpTool[] = [echoTool, ...DEVICE_TOOLS];
