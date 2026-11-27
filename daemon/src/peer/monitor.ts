import type { AppContext } from '../app/context.js';
import { log } from '../platform/log.js';
import { probeConnection } from './join.js';

const DEFAULT_INTERVAL_MS = 60_000;

type PeerProbe = (peerId: string) => Promise<{ online: boolean }>;

/**
 * Probe every outbound peer once. One unreachable peer must not stop the rest,
 * so failures stay per-peer.
 */
export async function probeOutboundPeers(
  ctx: AppContext,
  probe: PeerProbe = (peerId) => probeConnection(ctx, peerId),
): Promise<void> {
  const peers = ctx.db.listPeers('out');
  await Promise.all(
    peers.map(async (peer) => {
      try {
        await probe(peer.id);
      } catch (err) {
        log.warn(`peer probe failed for ${peer.id}`, err);
      }
    }),
  );
}

/**
 * Keep outbound peers' `last_seen_at` fresh.
 *
 * Agent availability is derived from that timestamp (five-minute window) rather
 * than a live probe, so without a refresher a reachable peer looks offline after
 * a restart or five idle minutes — and the @ picker refuses it even though a
 * direct run would work. Probing in the background keeps the heuristic honest.
 * A slow tick never stacks: the next interval waits for the previous one.
 */
export function startPeerMonitor(
  ctx: AppContext,
  options: { intervalMs?: number; probe?: PeerProbe } = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void probeOutboundPeers(ctx, options.probe)
      .catch((err) => log.warn('peer monitor tick failed', err))
      .finally(() => {
        running = false;
      });
  };
  // Probe immediately: the usual complaint is "just restarted and it says
  // offline", which happens before any interval would have elapsed.
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
