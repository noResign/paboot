import type { AppContext } from '../app/context.js';
import type { ToolServerSpec } from '../runtimes/types.js';

/**
 * Runtime injection for MCP servers. This module does not implement tools; it
 * turns a server's launch spec into each runtime's configuration mechanism
 * (Claude `--mcp-config`, Codex `-c mcp_servers.*`, DeepSeek ACP
 * `session/new.mcpServers`). Adding a runtime means implementing that
 * translation, not another tool implementation.
 */
export const TASK_TOOL_SERVER = 'paboot_tasks';
export const CAPABILITY_TOOL_SERVER = 'paboot_capability';
export const MEMORY_TOOL_SERVER = 'paboot_memory';

export function daemonUrlFor(config: AppContext['config']): string {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  return `${config.tls ? 'https' : 'http'}://${host}:${config.port}`;
}

function mcpServerEnv(ctx: AppContext, runId: string): Record<string, string> {
  return {
    // `process.execPath` is Electron's binary when the daemon is the one the
    // desktop bundled. An in-process MCP spawn (the builtin runtime) passes
    // exactly this env map, so the flag must travel with the spec or the
    // child would start a second GUI instead of a Node process.
    ...(process.env['ELECTRON_RUN_AS_NODE'] ? { ELECTRON_RUN_AS_NODE: process.env['ELECTRON_RUN_AS_NODE'] } : {}),
    PABOOT_DAEMON_URL: daemonUrlFor(ctx.config),
    // MCP servers only get the internal server token; the agent's own
    // environment carries the read-only agent token instead.
    PABOOT_TOKEN: ctx.config.serverToken,
    PABOOT_RUN_ID: runId,
  };
}

export function taskToolServer(ctx: AppContext, runId: string): ToolServerSpec {
  return {
    name: TASK_TOOL_SERVER,
    command: process.execPath,
    args: [ctx.mcpServerPath],
    env: mcpServerEnv(ctx, runId),
  };
}

/**
 * Per-run MCP servers. The builtin runtime consumes these specs directly via
 * its stdio client; external runtimes translate them into `--mcp-config`,
 * `-c mcp_servers.*` or ACP `session/new.mcpServers`.
 *
 * `PABOOT_RUNTIME` tells a self-gating server who launched it: the builtin
 * kernel already gates tools in-process, so its MCP servers must not ask again.
 */
export function capabilityToolServer(
  ctx: AppContext,
  runId: string,
  runtime: string,
): ToolServerSpec {
  return {
    name: CAPABILITY_TOOL_SERVER,
    command: process.execPath,
    args: [ctx.capabilityMcpServerPath],
    env: {
      ...mcpServerEnv(ctx, runId),
      PABOOT_RUNTIME: runtime,
    },
  };
}

/**
 * Memory tools call internal endpoints with the server token (the agent must
 * not be able to bypass the MCP gate by calling them directly). Read tools are
 * ungated; write tools ask the operator through `gate.ts`.
 */
export function memoryToolServer(
  ctx: AppContext,
  runId: string,
  sessionId: string,
  runtime: string,
): ToolServerSpec {
  return {
    name: MEMORY_TOOL_SERVER,
    command: process.execPath,
    args: [ctx.memoryMcpServerPath ?? ''],
    env: {
      ...(process.env['ELECTRON_RUN_AS_NODE'] ? { ELECTRON_RUN_AS_NODE: process.env['ELECTRON_RUN_AS_NODE'] } : {}),
      PABOOT_DAEMON_URL: daemonUrlFor(ctx.config),
      PABOOT_TOKEN: ctx.config.serverToken,
      PABOOT_RUN_ID: runId,
      PABOOT_SESSION_ID: sessionId,
      PABOOT_RUNTIME: runtime,
    },
  };
}

/**
 * Tool servers every run gets. Paths are optional only for partial test
 * contexts; production always wires all entries.
 */
export function perRunToolServers(
  ctx: AppContext,
  runId: string,
  runtime: string,
  sessionId: string,
  enabledServers: ReadonlySet<string> = new Set(),
): ToolServerSpec[] {
  const servers: ToolServerSpec[] = [];
  if (ctx.mcpServerPath) servers.push(taskToolServer(ctx, runId));
  if (ctx.capabilityMcpServerPath && enabledServers.has(CAPABILITY_TOOL_SERVER)) {
    servers.push(capabilityToolServer(ctx, runId, runtime));
  }
  if (ctx.memoryMcpServerPath) servers.push(memoryToolServer(ctx, runId, sessionId, runtime));
  return servers;
}

/** JSON string syntax is valid TOML for the strings we emit. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex reads MCP servers from `~/.codex/config.toml`; `-c` overrides are the
 * per-run, non-persistent way to add one. `approve` is required because Codex
 * refuses MCP calls under `approval_policy=never` unless the tool itself is
 * pre-approved.
 */
export function codexToolServerArgs(servers: ToolServerSpec[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const prefix = `mcp_servers.${server.name}`;
    args.push('-c', `${prefix}.command=${tomlString(server.command)}`);
    args.push('-c', `${prefix}.args=[${server.args.map(tomlString).join(',')}]`);
    const env = Object.entries(server.env)
      .map(([key, value]) => `${key}=${tomlString(value)}`)
      .join(',');
    args.push('-c', `${prefix}.env={${env}}`);
    args.push('-c', `${prefix}.default_tools_approval_mode="approve"`);
    args.push('-c', `${prefix}.startup_timeout_sec=20`);
  }
  return args;
}
