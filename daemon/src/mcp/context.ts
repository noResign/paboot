import type { ToolContext } from './types.js';

/**
 * Build the context for one MCP server process. The process is scoped to a
 * single run, so the run id and daemon credentials arrive through the env that
 * `injection.ts` wrote into the runtime's MCP server spec.
 */
export function createToolContext(env: NodeJS.ProcessEnv = process.env): ToolContext {
  const daemonUrl = env.PABOOT_DAEMON_URL ?? '';
  const token = env.PABOOT_TOKEN ?? '';
  const runId = env.PABOOT_RUN_ID ?? '';

  return {
    runId,
    async callDaemon(method, path, body) {
      if (!daemonUrl || !token || !runId) {
        throw new Error(
          'paboot task tool is not configured (missing PABOOT_DAEMON_URL/PABOOT_TOKEN/PABOOT_RUN_ID)',
        );
      }
      const response = await fetch(`${daemonUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        const message =
          parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
            ? (parsed as { error: string }).error
            : `daemon returned HTTP ${response.status}`;
        throw new Error(message);
      }
      return parsed;
    },
  };
}
