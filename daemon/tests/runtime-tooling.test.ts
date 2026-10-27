import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/runtimes/claude/adapter';
import { defaultCapabilities, type SpawnContext, type ToolServerSpec } from '../src/runtimes/types';
import { codexToolServerArgs } from '../src/mcp/tool-server';

const server: ToolServerSpec = {
  name: 'paboot_tasks',
  command: '/usr/bin/node',
  args: ['/opt/paboot/mcp-server.js'],
  env: { PABOOT_DAEMON_URL: 'http://127.0.0.1:4780', PABOOT_TOKEN: 'secret', PABOOT_RUN_ID: 'run-1' },
};

function ctx(mcpConfig: boolean): SpawnContext {
  return {
    prompt: 'hello',
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    env: process.env,
    capabilities: { ...defaultCapabilities, mcpConfig },
    toolServers: [server],
  };
}

describe('Claude MCP injection', () => {
  it('passes an inline --mcp-config when the CLI supports it', () => {
    const args = claudeAdapter.buildArgs(ctx(true));
    const index = args.indexOf('--mcp-config');
    expect(index).toBeGreaterThan(-1);
    const config = JSON.parse(args[index + 1]) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(config.mcpServers.paboot_tasks).toEqual({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  });

  it('never passes --mcp-config to a CLI that does not advertise it', () => {
    expect(claudeAdapter.buildArgs(ctx(false))).not.toContain('--mcp-config');
  });
});

describe('Codex MCP overrides', () => {
  it('emits -c mcp_servers.* overrides with approval', () => {
    const args = codexToolServerArgs([server]);
    expect(args).toContain('mcp_servers.paboot_tasks.command="/usr/bin/node"');
    expect(args).toContain('mcp_servers.paboot_tasks.args=["/opt/paboot/mcp-server.js"]');
    expect(args).toContain(
      'mcp_servers.paboot_tasks.env={PABOOT_DAEMON_URL="http://127.0.0.1:4780",PABOOT_TOKEN="secret",PABOOT_RUN_ID="run-1"}',
    );
    expect(args).toContain('mcp_servers.paboot_tasks.default_tools_approval_mode="approve"');
  });
});
