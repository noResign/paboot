import type { RunDto } from '../../../../shared/contract';

export const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  queued: '排队',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  rolled_back: '已回滚',
};

/**
 * Only a terminal run whose pre-checkpoint was captured can be rolled back.
 * A running/queued run has a `preRef` too, but restoring under a live run would
 * race it (the daemon rejects that with `run_active`).
 */
export function canRollbackRun(run: RunDto | undefined): boolean {
  if (!run?.checkpoint?.preRef) return false;
  return run.status !== 'rolled_back' && run.status !== 'running' && run.status !== 'queued';
}

/** A run's checkpoint diff needs both refs, so only a completed snapshot has one. */
export function canDiffRun(run: RunDto | undefined): boolean {
  return run?.checkpoint?.status === 'complete';
}
