import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app/context';
import { probeOutboundPeers, startPeerMonitor } from '../src/peer/index';

function ctxWith(peers: { id: string }[]): AppContext {
  return {
    db: { listPeers: vi.fn(() => peers) },
  } as unknown as AppContext;
}

describe('peer monitor', () => {
  it('probes every outbound peer and tolerates one failing', async () => {
    const ctx = ctxWith([{ id: 'p1' }, { id: 'p2' }]);
    const probe = vi.fn(async (peerId: string) => {
      if (peerId === 'p2') throw new Error('down');
      return { online: true };
    });

    await probeOutboundPeers(ctx, probe);

    expect(ctx.db.listPeers).toHaveBeenCalledWith('out');
    expect(probe.mock.calls.map((call) => call[0])).toEqual(['p1', 'p2']);
  });

  it('probes immediately so a restart does not report a stale offline peer', async () => {
    const ctx = ctxWith([{ id: 'p1' }]);
    const probe = vi.fn(async () => ({ online: true }));

    const stop = startPeerMonitor(ctx, { intervalMs: 60_000, probe });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith('p1'));
    stop();
  });
});
