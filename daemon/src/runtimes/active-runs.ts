/**
 * Runtime-independent lifecycle used by cancellation, discovery and replay.
 * Generic over the outcome so a caller that awaits `promise` keeps the run's
 * result type; the registry-wide map stores them with the outcome erased.
 */
export interface ManagedRun<O = unknown> {
  id: string;
  promise: Promise<O>;
  cancel(reason?: string): void;
}

const activeRuns = new Map<string, ManagedRun>();

export function getActiveRun(id: string): ManagedRun | undefined {
  return activeRuns.get(id);
}

export function listActiveRuns(): ManagedRun[] {
  return [...activeRuns.values()];
}

export function registerActiveRun(run: ManagedRun): void {
  activeRuns.set(run.id, run);
  const remove = (): void => {
    if (activeRuns.get(run.id) === run) activeRuns.delete(run.id);
  };
  void run.promise.then(remove, remove);
}
