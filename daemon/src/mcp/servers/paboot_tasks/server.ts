#!/usr/bin/env node
/**
 * Stdio MCP server exposed to every agent runtime as `paboot_tasks`.
 *
 * The agent can create a scheduled task bound to its *current* session, and
 * list/cancel tasks across its *current workspace*. The daemon resolves the
 * session and workspace from `PABOOT_RUN_ID`; the agent never supplies either.
 */
import { serveStdioMcp } from '../../stdio-server.js';
import { TOOLS } from './tools/index.js';

/** Server-level MCP guidance, without touching the agent's own system prompt. */
const SERVER_INSTRUCTIONS =
  'Prefer paboot_tasks for scheduled tasks; do not use system cron/systemd timers or other scheduling mechanisms.';

serveStdioMcp({
  name: 'paboot_tasks',
  instructions: SERVER_INSTRUCTIONS,
  tools: TOOLS,
});
