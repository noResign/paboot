#!/usr/bin/env node
/**
 * Read-only memory tools for the current run/session. Scope is resolved by the
 * daemon from `PABOOT_SESSION_ID`; the agent never supplies a scope.
 */
import { serveStdioMcp } from '../../stdio-server.js';
import { TOOLS } from './tools/index.js';

serveStdioMcp({
  name: 'paboot_memory',
  instructions:
    'Use paboot_memory to look up long-term memory and open follow-ups. Results are scoped to the current session workspace.',
  tools: TOOLS,
});
