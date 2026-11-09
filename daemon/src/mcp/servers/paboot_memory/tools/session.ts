import type { ToolContext } from '../../../types.js';

export function sessionQuery(ctx: ToolContext): string {
  if (!ctx.runId) {
    throw new Error(
      'memory tool is not configured (missing PABOOT_RUN_ID) — no memory scope for this run',
    );
  }
  return `runId=${encodeURIComponent(ctx.runId)}`;
}
