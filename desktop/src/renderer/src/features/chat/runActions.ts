import type { RunDto } from '../../../../shared/contract';

/**
 * Only a terminal run whose pre-checkpoint was captured can be rolled back.
 * A running/queued run has a `preRef` too, but restoring under a live run would
 * race it (the daemon rejects that with `run_active`).
 */
export function canRollbackRun(run: RunDto | undefined): boolean {
  if (!run?.checkpoint?.preRef) return false;
  return run.status !== 'rolled_back' && run.status !== 'running' && run.status !== 'queued';
}
