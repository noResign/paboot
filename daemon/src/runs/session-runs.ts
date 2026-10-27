import type { AppContext } from '../app/context.js';
import { listActiveRuns } from '../runtimes/active-runs.js';

/**
 * Map each in-flight run's session id → run id, including checkpoint work.
 * The DB row reserves a session before its driver starts and until finalization.
 *
 * One entry per session: a session has at most one in-flight run because
 * `POST /api/chat` refuses to start a second one (`session_busy`), so the last
 * write can never clobber a different run.
 */
export function runningRunBySession(ctx: AppContext): Map<string, string> {
  const map = new Map(ctx.db.listRunningRuns().map((run) => [run.session_id, run.id]));
  for (const active of listActiveRuns()) {
    const row = ctx.db.getRun(active.id);
    if (row) map.set(row.session_id, row.id);
  }
  return map;
}

/** The in-flight run id for a session, or null when it is idle. */
export function activeRunIdForSession(ctx: AppContext, sessionId: string): string | null {
  return runningRunBySession(ctx).get(sessionId) ?? null;
}
