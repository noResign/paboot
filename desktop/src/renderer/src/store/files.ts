import { create } from 'zustand';
import type { ChangesResponse } from '../../../shared/contract';

/**
 * Renderer-side cache for the change list. The chat's right panel unmounts
 * when you navigate away, so without this every re-open pays a fresh
 * `git status` + two `git diff --numstat` round-trip on the daemon — which is
 * slow precisely when you want it: while a run is rewriting the tree.
 *
 * Keyed by `(connection, workspace, root)` because the change list is relative
 * to that root. Stale entries are simply never read again.
 */
interface FilesCacheState {
  changes: Record<string, ChangesResponse>;
  putChanges(key: string, data: ChangesResponse): void;
}

export function changesKey(connectionId: string, workspaceId: string, root: string | null): string {
  return `${connectionId}|${workspaceId}|${root ?? ''}`;
}

export const useFilesCache = create<FilesCacheState>((set) => ({
  changes: {},
  putChanges(key, data) {
    set((state) => ({ changes: { ...state.changes, [key]: data } }));
  },
}));
