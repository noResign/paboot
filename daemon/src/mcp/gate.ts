/**
 * Permission gate for self-gating MCP servers (capability / memory).
 *
 * The server process owns the decision point: it asks the daemon's internal
 * permission API and only runs the tool once the operator allows it. This keeps
 * the gate identical across Claude / Codex / DeepSeek, neither of which can be
 * trusted to gate MCP calls on its own.
 *
 * The builtin runtime is the exception: its ToolExecutor already asks
 * `PermissionManager` before calling an MCP tool, so the server must not ask
 * again (otherwise the user sees two prompts).
 */
import type { ToolContext } from './types.js';

const POLL_INTERVAL_MS = 250;
const GATE_TIMEOUT_MS = 5 * 60_000;
const MAX_TRANSIENT_FAILURES = 3;

export class ToolPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPermissionError';
  }
}

interface CreatedPermission {
  id?: unknown;
}

interface PermissionStatus {
  status?: unknown;
  decisionReason?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve before executing a side-effecting tool; throw to fail closed.
 * `toolName` must be the namespaced `mcp__<server>__<tool>` name so grants and
 * the Claude hook matcher see the same key the runtime does.
 */
export async function requireToolPermission(
  ctx: ToolContext,
  toolName: string,
  toolInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.PABOOT_RUNTIME === 'builtin') return;

  const created = (await ctx.callDaemon('POST', '/api/internal/permissions/create', {
    runId: ctx.runId,
    toolName,
    toolInput: toolInput ?? null,
  })) as CreatedPermission;
  const id = typeof created?.id === 'string' ? created.id : '';
  if (!id) throw new ToolPermissionError('permission request was not created');

  const deadline = Date.now() + GATE_TIMEOUT_MS;
  let transientFailures = 0;
  while (Date.now() < deadline) {
    try {
      const result = (await ctx.callDaemon(
        'GET',
        `/api/internal/permissions/${encodeURIComponent(id)}/status`,
      )) as PermissionStatus;
      transientFailures = 0;
      if (result.status === 'allowed') return;
      if (result.status === 'denied') throw new ToolPermissionError('tool call denied by user');
      if (result.status === 'timed_out') throw new ToolPermissionError('tool approval timed out');
    } catch (err) {
      if (err instanceof ToolPermissionError) throw err;
      // A dead daemon must deny rather than leave the tool call hanging. A few
      // retries absorb a transient socket error during normal operation.
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_FAILURES) {
        throw new ToolPermissionError('permission gate unavailable');
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ToolPermissionError('tool approval timed out');
}
