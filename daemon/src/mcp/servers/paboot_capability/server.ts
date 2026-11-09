#!/usr/bin/env node
/**
 * Stdio MCP server for Dev Space capabilities (`paboot_capability`).
 *
 * P5.1 ships only the `echo` stub. It exists to prove the shared contract:
 * multiple MCP servers per run, and side-effecting tools self-gate through the
 * daemon's internal permission API. Real device / mock providers land in A1.
 */
import { serveStdioMcp } from '../../stdio-server.js';
import { TOOLS } from './tools/index.js';

serveStdioMcp({
  name: 'paboot_capability',
  version: '0.1.0',
  instructions:
    'paboot_capability exposes Dev Space capabilities. Side-effecting calls require operator approval.',
  tools: TOOLS,
});
