import type { AppContext } from '../app/context.js';
import { listActiveRuns } from '../runtimes/active-runs.js';

/**
 * Map every in-flight run's session id → all active run ids, including
 * checkpoint work. A plain chat has at most one; a room deliberately has one
 * per answering agent, so this map must not collapse them.
 */
export function runningRunIdsBySession(ctx: AppContext): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (sessionId: string, runId: string): void => {
    const current = map.get(sessionId);
    if (!current) map.set(sessionId, [runId]);
    else if (!current.includes(runId)) current.push(runId);
  };
  for (const run of ctx.db.listRunningRuns()) add(run.session_id, run.id);
  for (const active of listActiveRuns()) {
    const row = ctx.db.getRun(active.id);
    if (row) add(row.session_id, row.id);
  }
  return map;
}

/**
 * Legacy single-run view, used by `/api/chat`'s session-busy guard and older
 * clients. New code should use {@link runningRunIdsBySession}.
 */
export function runningRunBySession(ctx: AppContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const [sessionId, ids] of runningRunIdsBySession(ctx)) {
    const first = ids[0];
    if (first) map.set(sessionId, first);
  }
  return map;
}

/** The first in-flight run id for a session, or null when it is idle. */
export function activeRunIdForSession(ctx: AppContext, sessionId: string): string | null {
  return runningRunBySession(ctx).get(sessionId) ?? null;
}
