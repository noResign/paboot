import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The hook no longer decides anything locally: the only tools in the matcher
 * (Bash, the write/edit tools, WebSearch/WebFetch, MCP) are genuine asks, so every call is relayed
 * to the daemon. These tests drive the real script (via tsx) with no daemon
 * configured — each tool must therefore come back denied with a
 * "not configured" reason, proving nothing is auto-allowed in-process.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, '../src/permission-hook.ts');
const tsxBin = path.join(here, '../node_modules/.bin/tsx');

interface HookResult {
  decision: 'allow' | 'deny';
  reason: string;
}

/**
 * Strips the paboot env on purpose. These tests may well run inside a
 * daemon-spawned agent (that is the product), and inheriting its DAEMON_URL /
 * TOKEN / RUN_ID would send every probe to a live daemon — which answers
 * "auto-allowed" from real grants and silently hides whether the relay works.
 */
function hookEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PABOOT_DAEMON_URL;
  delete env.PABOOT_TOKEN;
  delete env.PABOOT_RUN_ID;
  delete env.PABOOT_PERMISSION_TIMEOUT_MS;
  return env;
}

function runHook(toolName: string, toolInput: unknown, rawInput?: string): HookResult {
  const stdout = execFileSync(tsxBin, [hookPath], {
    input: rawInput ?? JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: hookEnv(),
  });
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: 'allow' | 'deny'; permissionDecisionReason: string };
  };
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

describe('permission hook (pure relay)', () => {
  it('relays Bash to the daemon', () => {
    const result = runHook('Bash', { command: 'ls' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not configured');
  });

  it('relays a Write to the daemon', () => {
    const result = runHook('Write', { file_path: '/tmp/x.txt', content: 'x' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not configured');
  });

  it('relays an MCP tool to the daemon', () => {
    const result = runHook('mcp__github__create_issue', { title: 'x' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not configured');
  });

  it('denies unparseable hook input', () => {
    const result = runHook('Bash', {}, 'not json');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('unparseable');
  });
});
