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

export function daemonUrlFor(config: AppContext['config']): string {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  return `${config.tls ? 'https' : 'http'}://${host}:${config.port}`;
}

export function taskToolServer(ctx: AppContext, runId: string): ToolServerSpec {
  return {
    name: TASK_TOOL_SERVER,
    command: process.execPath,
    args: [ctx.mcpServerPath],
    env: {
      PABOOT_DAEMON_URL: daemonUrlFor(ctx.config),
      PABOOT_TOKEN: ctx.config.token,
      PABOOT_RUN_ID: runId,
    },
  };
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
