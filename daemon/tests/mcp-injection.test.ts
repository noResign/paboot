import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { perRunToolServers, taskToolServer } from '../src/mcp/injection';

function ctx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    config: {
      host: '127.0.0.1',
      port: 4780,
      tls: false,
      token: 'operator-token',
      agentToken: 'agent-token',
      serverToken: 'server-token',
    },
    mcpServerPath: '/opt/paboot/mcp/servers/paboot_tasks/server.js',
    memoryMcpServerPath: '/opt/paboot/mcp/servers/paboot_memory/server.js',
    ...overrides,
  } as unknown as AppContext;
}

describe('taskToolServer', () => {
  it('injects the server token, never the operator or agent token', () => {
    const spec = taskToolServer(ctx(), 'run-1');
    expect(spec.env.PABOOT_TOKEN).toBe('server-token');
    expect(spec.env.PABOOT_TOKEN).not.toBe('operator-token');
    expect(spec.env.PABOOT_TOKEN).not.toBe('agent-token');
    expect(spec.env.PABOOT_RUN_ID).toBe('run-1');
  });
});

describe('perRunToolServers', () => {
  it('mounts tasks and memory', () => {
    const specs = perRunToolServers(ctx(), 'run-1', 'builtin', 'session-1');
    expect(specs.map((spec) => spec.name)).toEqual(['paboot_tasks', 'paboot_memory']);
    expect(specs[1]?.env).toMatchObject({
      PABOOT_SESSION_ID: 'session-1',
      PABOOT_TOKEN: 'server-token',
      PABOOT_RUNTIME: 'builtin',
    });
  });

  it('omits entries whose path is not wired (partial test contexts)', () => {
    const specs = perRunToolServers(
      ctx({ mcpServerPath: '', memoryMcpServerPath: '' }),
      'run-1',
      'claude',
      'session-1',
    );
    expect(specs).toEqual([]);
  });
});
