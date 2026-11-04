import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { taskToolServer } from '../src/mcp/injection';

function ctx(): AppContext {
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
