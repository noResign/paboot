import { create } from 'zustand';
import { connectionApi, setActiveConnectionId } from '../ipc/client';
import { useChat } from './chat';
import type { ConnectInput, ConnectionView, ProbeResult } from '../../../shared/ipc';

interface ConnectionState {
  /** Every host main holds, each with its own status (§4). */
  views: ConnectionView[];
  /** Which host the rail and main area are scoped to. Per window, not persisted. */
  activeId: string | null;
  probe: ProbeResult | null;
  booting: boolean;
  probing: boolean;
  connecting: boolean;
  error: string | null;
  /** Machine-readable reason for the last failed connect, e.g. `token_required`. */
  errorCode: string | null;
  /**
   * The host「添加电脑」was opened from. The connect page offers a way back to it,
   * so a user who changed their mind is not stranded with no active host.
   */
  returnToId: string | null;
  activeView(): ConnectionView | null;
  boot(): Promise<void>;
  /**
   * Pull main's views again. Needed after an action that changes them from
   * outside the connect flow: starting or stopping the local daemon flips a host
   * between connected and down, and `App` picks shell vs connect page on exactly
   * that flag.
   */
  refreshViews(): Promise<void>;
  probeNow(): Promise<ProbeResult>;
  connect(input: ConnectInput): Promise<boolean>;
  /** Navigate to another host. Nothing is re-established — it is already live. */
  switchTo(id: string): void;
  /** Show the connect page to add a host, *without* dropping the others. */
  addHost(): void;
  /** Leave「添加电脑」and go back to the host it was opened from, if still there. */
  cancelAddHost(): void;
  removeHost(id: string): Promise<void>;
  disconnectAll(): Promise<void>;
}

export const useConnection = create<ConnectionState>((set, get) => ({
  views: [],
  activeId: null,
  probe: null,
  booting: true,
  probing: false,
  connecting: false,
  error: null,
  errorCode: null,
  returnToId: null,

  activeView() {
    const { views, activeId } = get();
    return views.find((view) => view.id === activeId) ?? null;
  },

  async boot() {
    set({ booting: true });
    try {
      const result = await connectionApi.boot();
      // Prefer the remembered host, but never land on one we cannot talk to when
      // another one is usable.
      const remembered = result.connections.find((view) => view.id === result.activeId);
      const activeId =
        remembered?.connected === true
          ? remembered.id
          : (result.connections.find((view) => view.connected)?.id ?? result.activeId);
      // The probe is informational only — it never connects or starts anything.
      set({ views: result.connections, activeId, probe: result.probe, booting: false, error: null, errorCode: null });
      setActiveConnectionId(activeId);
    } catch (err) {
      set({ booting: false, error: messageOf(err) });
    }
  },

  async refreshViews() {
    set({ views: await connectionApi.list() });
  },

  async probeNow() {
    set({ probing: true });
    try {
      const probe = await connectionApi.probe();
      set({ probe, probing: false });
      return probe;
    } catch (err) {
      set({ probing: false, error: messageOf(err) });
      return { found: null, tried: [], portConflict: null, localToken: null };
    }
  },

  async connect(input) {
    set({ connecting: true, error: null, errorCode: null });
    const result = await connectionApi.set(input);
    if (!result.ok) {
      set({ connecting: false, error: result.message, errorCode: result.code });
      return false;
    }
    // Adding a host leaves the others connected; this one just becomes current.
    const views = await connectionApi.list();
    set({ views, activeId: result.view.id, connecting: false, returnToId: null });
    setActiveConnectionId(result.view.id);
    return true;
  },

  switchTo(id) {
    // The chat store is keyed by connection id, so its caches survive; only the
    // *open* one has to go, or the shell would keep showing the other host's.
    useChat.getState().leave();
    set({ activeId: id, returnToId: null });
    setActiveConnectionId(id);
  },

  addHost() {
    // Drop nothing in main — just stop pointing at a host so the connect page shows.
    useChat.getState().leave();
    set({ activeId: null, returnToId: get().activeId });
    setActiveConnectionId(null);
  },

  cancelAddHost() {
    const id = get().returnToId;
    if (!id) return;
    // The host we came from can be gone (removed in another window). Then there is
    // nothing to go back to — fall through to the connect page rather than a blank.
    if (!get().views.some((view) => view.id === id && view.connected)) {
      set({ returnToId: null });
      return;
    }
    set({ activeId: id, returnToId: null });
    setActiveConnectionId(id);
  },

  async removeHost(id) {
    const views = await connectionApi.remove(id);
    const stillThere = views.some((view) => view.id === get().activeId);
    const activeId = stillThere ? get().activeId : (views.find((view) => view.connected)?.id ?? views[0]?.id ?? null);
    if (activeId !== get().activeId) useChat.getState().leave();
    set({ views, activeId });
    setActiveConnectionId(activeId);
  },

  async disconnectAll() {
    // Everything the chat store holds is keyed by connection id, so it all
    // describes hosts we are leaving. Clear it before the shell can remount and
    // re-select a previous host's session from the stale open chat.
    useChat.getState().reset();
    const views = await connectionApi.clear();
    set({ views, activeId: null });
    setActiveConnectionId(null);
  },
}));

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
