/**
 * Which trace the panel may render right now.
 *
 * The pane keeps a fetched snapshot in state, and clearing it happens in an
 * effect — i.e. *after* the frame that already ran with the previous run's
 * value. So the render path cannot trust that `trace` belongs to `runId`; it
 * has to check. Without this, clicking another agent's "查看轨迹" shows the
 * previous agent's trace until the new fetch lands.
 *
 * Pure so the rule is testable without a DOM (the project has no renderer
 * environment): a fetched snapshot whose `runId` does not match is not shown at
 * all, rather than shown and then replaced.
 */
export function pickTraceMessage<T extends { runId?: string | null }>(
  live: { runId: string; message: T } | null,
  fetched: T | null,
  runId: string,
): T | null {
  // Both branches check the run. A live answer happens to be scoped already
  // (`findLiveAnswer` only returns answers for the run it is asked about), but
  // relying on a caller's discipline is how this bug comes back through a new
  // entry point — the check is one comparison.
  if (live && live.runId === runId) return live.message;
  if (fetched && fetched.runId === runId) return fetched;
  return null;
}
