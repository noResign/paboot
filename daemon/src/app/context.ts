import type { Config } from './config.js';
import type { Db } from '../db/db.js';
import type { PermissionManager } from '../permissions/permissions.js';
import type { RunNotifier } from '../runs/run-notifier.js';
import type { Registry } from '../runtimes/registry.js';

/**
 * Shared dependency object threaded through route registrars. Keep this the
 * single place where daemon-wide services are wired, so adding a runtime or a
 * new domain never forces routes to reach into globals.
 */
export interface AppContext {
  config: Config;
  db: Db;
  registry: Registry;
  permissions: PermissionManager;
  notifier: RunNotifier;
  /** Absolute path to the compiled PreToolUse permission-hook script. */
  hookPath: string;
  /** Absolute path to the compiled stdio MCP server script. */
  mcpServerPath: string;
}
