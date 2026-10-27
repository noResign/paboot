import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ipc/client', () => ({
  connectionApi: {
    boot: vi.fn(),
    probe: vi.fn(),
    set: vi.fn(),
    list: vi.fn(),
    prefsGet: vi.fn(),
    daemonStart: vi.fn(),
  },
  setActiveConnectionId: vi.fn(),
}));
vi.mock('./chat', () => ({
  useChat: { getState: () => ({ leave: () => {}, reset: () => {} }) },
}));

import { connectionApi } from '../ipc/client';
import { useConnection } from './connection';
import type { ConnectionView, DiscoveredDaemon, ProbeResult } from '../../../shared/ipc';

const boot = vi.mocked(connectionApi.boot);
const probe = vi.mocked(connectionApi.probe);
const set = vi.mocked(connectionApi.set);
const list = vi.mocked(connectionApi.list);
const prefsGet = vi.mocked(connectionApi.prefsGet);
const daemonStart = vi.mocked(connectionApi.daemonStart);

const EMPTY: ProbeResult = { found: null, tried: [], portConflict: null, localToken: null };
const PREFS = {
  closeBehavior: 'ask' as const,
  daemonOnQuit: 'ask' as const,
  desktopNotifications: true,
  autoStartDaemon: true,
};

function daemon(over: Partial<DiscoveredDaemon> = {}): DiscoveredDaemon {
  return {
    source: 'managed',
    listen: '127.0.0.1:4780',
    tls: false,
    version: '1.8.0',
    workspace: '/home/me/project',
    serverId: 'srv-1',
    dataDir: '/home/me/.paboot',
    hostname: 'me-laptop',
    tokenSource: 'file',
    ...over,
  };
}

function view(id: string, over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id,
    baseUrl: id,
    serverId: null,
    connected: true,
    name: null,
    host: null,
    port: null,
    tls: false,
    hasToken: true,
    tokenEphemeral: false,
    tokenSource: null,
    ...over,
  };
}

describe('connection probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsGet.mockResolvedValue({ ...PREFS, autoStartDaemon: false });
    useConnection.setState({ probe: null, views: [], activeId: null, returnToId: null, booting: true });
  });

  it('replaces the stale boot probe with a fresh one', async () => {
    // Boot runs once, before any daemon may exist. `probeNow` is what the connect
    // page relies on to refresh that snapshot, so it must overwrite it wholesale
    // rather than keep the first answer.
    boot.mockResolvedValue({ connections: [], activeId: null, probe: EMPTY });
    probe.mockResolvedValue({ ...EMPTY, found: daemon() });

    await useConnection.getState().boot();
    expect(useConnection.getState().probe?.found).toBeNull();

    const fresh = await useConnection.getState().probeNow();
    expect(fresh.found?.listen).toBe('127.0.0.1:4780');
    expect(useConnection.getState().probe?.found?.listen).toBe('127.0.0.1:4780');
  });
});

describe('boot auto-provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnection.setState({ probe: null, views: [], activeId: null, returnToId: null, booting: true });
  });

  it('keeps a down remote as the target and does not start a local daemon', async () => {
    const remote = 'http://10.0.0.5:4780';
    boot.mockResolvedValue({
      connections: [view(remote, { connected: false, host: '10.0.0.5', port: 4780 })],
      activeId: remote,
      probe: EMPTY,
    });

    await useConnection.getState().boot();

    expect(daemonStart).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(useConnection.getState().activeId).toBe(remote);
  });

  it('attaches to a discovered local daemon without starting one', async () => {
    const local = 'http://127.0.0.1:4780';
    boot.mockResolvedValue({ connections: [], activeId: null, probe: { ...EMPTY, found: daemon() } });
    set.mockResolvedValue({ ok: true, view: view(local) });
    list.mockResolvedValue([view(local)]);

    await useConnection.getState().boot();

    expect(daemonStart).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 4780 }));
    expect(useConnection.getState().activeId).toBe(local);
  });

  it('starts the built-in daemon when nothing is running', async () => {
    const local = 'http://127.0.0.1:4781';
    boot.mockResolvedValue({ connections: [], activeId: null, probe: EMPTY });
    prefsGet.mockResolvedValue({ ...PREFS, autoStartDaemon: true });
    daemonStart.mockResolvedValue({ ok: true, pid: 1, listen: '127.0.0.1:4781', token: 'tok' });
    set.mockResolvedValue({ ok: true, view: view(local) });
    list.mockResolvedValue([view(local)]);

    await useConnection.getState().boot();

    expect(daemonStart).toHaveBeenCalledWith({ workspace: '~/.paboot/defaultworkspace', port: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 4781, token: 'tok' }));
    expect(useConnection.getState().activeId).toBe(local);
  });

  it('leaves the connect page alone when auto-start is off', async () => {
    boot.mockResolvedValue({ connections: [], activeId: null, probe: EMPTY });
    prefsGet.mockResolvedValue({ ...PREFS, autoStartDaemon: false });

    await useConnection.getState().boot();

    expect(daemonStart).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(useConnection.getState().booting).toBe(false);
  });
});

describe('connection navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnection.setState({ views: [], activeId: null, returnToId: null, probe: null, booting: true });
  });

  it('remembers the host「添加电脑」was opened from and returns there', () => {
    const home = view('http://127.0.0.1:4780');
    useConnection.setState({ views: [home], activeId: home.id });

    useConnection.getState().addHost();
    expect(useConnection.getState().activeId).toBeNull();
    expect(useConnection.getState().returnToId).toBe(home.id);

    useConnection.getState().cancelAddHost();
    expect(useConnection.getState().activeId).toBe(home.id);
    expect(useConnection.getState().returnToId).toBeNull();
  });

  it('leaves the user on the connect page when the origin host is gone', () => {
    const home = view('http://127.0.0.1:4780');
    useConnection.setState({ views: [home], activeId: home.id });
    useConnection.getState().addHost();

    // Removed in another window — there is nothing to go back to.
    useConnection.setState({ views: [] });
    useConnection.getState().cancelAddHost();
    expect(useConnection.getState().activeId).toBeNull();
    expect(useConnection.getState().returnToId).toBeNull();
  });
});
