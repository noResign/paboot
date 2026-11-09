import type { ToolContext } from '../../../types.js';

export function sessionQuery(ctx: ToolContext): string {
  if (!ctx.sessionId) {
    throw new Error(
      'memory tool is not configured (missing PABOOT_SESSION_ID) — no memory scope for this run',
    );
  }
  return `sessionId=${encodeURIComponent(ctx.sessionId)}`;
}
