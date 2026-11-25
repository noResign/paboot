import type { Db } from '../db/db.js';
import { cancelPeerRun } from './client.js';

/**
 * Cancel runs this machine left in flight on other daemons.
 *
 * Called before `interruptOrphanedRuns`: after that sweep no local row is
 * `running` any more, so the `remote_run_id` list would be gone. Best-effort —
 * if the peer is offline we cannot cancel, and its contract wall clock will
 * eventually reap the run anyway.
 */
export async function reconcilePeerRuns(db: Db): Promise<number> {
  const runs = db
    .listRunningRuns()
    .filter((run) => run.peer_id && run.remote_run_id && run.runtime.startsWith('peer:'));
  if (runs.length === 0) return 0;
  const results = await Promise.allSettled(
    runs.map(async (run) => {
      const peer = db.getPeer(run.peer_id!);
      if (!peer || peer.direction !== 'out' || !peer.token_cipher || !run.remote_run_id) return false;
      await cancelPeerRun(peer.base_url, peer.token_cipher, run.remote_run_id);
      return true;
    }),
  );
  return results.filter((result) => result.status === 'fulfilled' && result.value).length;
}
