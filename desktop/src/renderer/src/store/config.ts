import { create } from 'zustand';
import { api } from '../ipc/client';
import type { ConfigResponse } from '../../../shared/contract';

interface ConfigState {
  config: ConfigResponse | null;
  loading: boolean;
  load(force?: boolean): Promise<void>;
}

/**
 * Daemon-wide config shared by the shell. Only a few fields are UI-relevant;
 * `bypassAllowed` decides whether any screen may offer the bypass mode.
 */
export const useConfig = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  async load(force = false) {
    if (!force && (get().config !== null || get().loading)) return;
    set({ loading: true });
    const res = await api.config();
    set({ loading: false, config: res.ok ? res.data : null });
  },
}));

/** Legacy daemons do not send the field; default to the local profile. */
export function bypassAllowedOf(config: ConfigResponse | null): boolean {
  return config?.bypassAllowed ?? true;
}
