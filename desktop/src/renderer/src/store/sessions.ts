import { create } from 'zustand';
import { api } from '../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../shared/errors';
import { removeWorkspace, replaceWorkspace, setWorkspaceDirs } from './workspaceList';
import type { SessionDto, WorkspaceDto } from '../../../shared/contract';

/**
 * Session and workspace state, keyed by connection id. M1 only ever shows one
 * connection, but the key exists from day one: `(connectionId, sessionId)` is
 * the structure that makes "two machines on screen at once" an added
 * subscriber later instead of a rewrite.
 */
export interface ConnectionScope {
  workspaces: WorkspaceDto[];
  sessions: SessionDto[];
  /** Which workspace `sessions` was loaded for — see {@link visibleSessions}. */
  sessionsWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
}

export const EMPTY_SCOPE: ConnectionScope = {
  workspaces: [],
  sessions: [],
  sessionsWorkspaceId: null,
  loading: false,
  error: null,
};

/** Outcome of a workspace mutation, shaped for direct display in the page. */
export type WorkspaceMutation = { ok: true; workspace?: WorkspaceDto } | { ok: false; error: string };

interface SessionsState {
  byConnection: Record<string, ConnectionScope>;
  /**
   * Workspaces and sessions load **separately**: the workspace list is what
   * decides which sessions to ask for, so sessions can only be fetched once a
   * workspace is chosen. `loadSessions` deliberately *requires* a `workspaceId`
   * — asking the daemon without one returns every workspace's sessions, which is
   * the batch that used to flash into the rail before the default workspace
   * resolved.
   *
   * `silent` skips the loading flag: the rail polls on a timer, and flipping
   * `loading` would flash skeletons over a list the user is reading.
   */
  loadWorkspaces(connectionId: string, options?: { silent?: boolean }): Promise<void>;
  loadSessions(connectionId: string, workspaceId: string, options?: { silent?: boolean }): Promise<void>;
  /**
   * Re-read whatever batch the rail is currently showing. The store knows which
   * workspace that is (`sessionsWorkspaceId`), so a caller like "a run just
   * ended" doesn't have to — and can't accidentally ask for *all* workspaces.
   * A no-op before the first batch has landed.
   */
  refreshCurrent(connectionId: string, options?: { silent?: boolean }): Promise<void>;
  patchTitle(connectionId: string, sessionId: string, title: string): void;
  remove(connectionId: string, sessionId: string): void;

  /** Workspace mutations live here because the rail's dropdown reads the same list. */
  createWorkspace(connectionId: string, path: string, name?: string): Promise<WorkspaceMutation>;
  updateWorkspace(
    connectionId: string,
    id: string,
    patch: { name?: string; enabled?: boolean },
  ): Promise<WorkspaceMutation>;
  deleteWorkspace(connectionId: string, id: string, cascade: boolean): Promise<WorkspaceMutation>;
  addWorkspaceDir(connectionId: string, id: string, path: string): Promise<WorkspaceMutation>;
  removeWorkspaceDir(connectionId: string, id: string, path: string): Promise<WorkspaceMutation>;
}

export const useSessions = create<SessionsState>((set, get) => ({
  byConnection: {},

  async loadWorkspaces(connectionId, options) {
    if (!options?.silent) {
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...(state.byConnection[connectionId] ?? EMPTY_SCOPE), loading: true, error: null },
        },
      }));
    }

    const res = await api.workspaces();

    set((state) => {
      const previous = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...previous,
            workspaces: res.ok ? res.data.workspaces : previous.workspaces,
            loading: false,
            error: res.ok ? null : `加载失败（HTTP ${res.status}）`,
          },
        },
      };
    });
  },

  async loadSessions(connectionId, workspaceId, options) {
    if (!options?.silent) {
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...(state.byConnection[connectionId] ?? EMPTY_SCOPE), loading: true, error: null },
        },
      }));
    }

    const res = await api.sessions(workspaceId);

    set((state) => {
      const previous = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...previous,
            sessions: res.ok ? res.data.sessions : previous.sessions,
            // Only a successful fetch establishes provenance — a failed one must
            // not relabel the old batch as belonging to the new workspace.
            sessionsWorkspaceId: res.ok ? workspaceId : previous.sessionsWorkspaceId,
            loading: false,
            error: res.ok ? null : `加载失败（HTTP ${res.status}）`,
          },
        },
      };
    });
  },

  async refreshCurrent(connectionId, options) {
    const workspaceId = get().byConnection[connectionId]?.sessionsWorkspaceId;
    if (!workspaceId) return;
    await get().loadSessions(connectionId, workspaceId, options);
  },

  patchTitle(connectionId, sessionId, title) {
    set((state) => ({ byConnection: mapSessions(state, connectionId, (sessions) =>
      sessions.map((s) => (s.id === sessionId ? { ...s, title } : s))) }));
  },

  remove(connectionId, sessionId) {
    set((state) => ({ byConnection: mapSessions(state, connectionId, (sessions) =>
      sessions.filter((s) => s.id !== sessionId)) }));
  },

  async createWorkspace(connectionId, path, name) {
    const res = await api.createWorkspace(path, name);
    if (!res.ok) return mutationFailure(res);
    const workspace = res.data.workspace;
    set((state) => ({ byConnection: mapWorkspaces(state, connectionId, (list) => replaceWorkspace(list, workspace)) }));
    // The first real workspace hides the built-in fallback and takes the default;
    // only a server list tells us that, so re-read it.
    await get().loadWorkspaces(connectionId, { silent: true });
    return { ok: true, workspace };
  },

  async updateWorkspace(connectionId, id, patch) {
    const res = await api.updateWorkspace(id, patch);
    if (!res.ok) return mutationFailure(res);
    const workspace = res.data.workspace;
    set((state) => ({
      byConnection: mapWorkspaces(state, connectionId, (list) => replaceWorkspace(list, workspace)),
    }));
    // Enabling/disabling can change which workspaces are visible (and which is
    // the default), so mirror the server instead of guessing.
    await get().loadWorkspaces(connectionId, { silent: true });
    return { ok: true, workspace };
  },

  async deleteWorkspace(connectionId, id, cascade) {
    const res = await api.deleteWorkspace(id, cascade);
    if (!res.ok) return mutationFailure(res);
    set((state) => {
      // Cascade already removed the sessions server-side; dropping them here
      // keeps the rail honest until the next poll.
      const withoutWorkspace = mapWorkspaces(state, connectionId, (list) => removeWorkspace(list, id));
      return {
        byConnection: mapSessions({ ...state, byConnection: withoutWorkspace }, connectionId, (sessions) =>
          sessions.filter((session) => session.workspaceId !== id),
        ),
      };
    });
    // Deleting the default hands the flag to another workspace server-side; the
    // local list has to learn which one so the next fallback opens the right row.
    await get().loadWorkspaces(connectionId, { silent: true });
    return { ok: true };
  },

  async addWorkspaceDir(connectionId, id, path) {
    const res = await api.addWorkspaceDir(id, path);
    if (!res.ok) return mutationFailure(res);
    set((state) => ({
      byConnection: mapWorkspaces(state, connectionId, (list) => setWorkspaceDirs(list, id, res.data.dirs)),
    }));
    return { ok: true };
  },

  async removeWorkspaceDir(connectionId, id, path) {
    const res = await api.removeWorkspaceDir(id, path);
    if (!res.ok) return mutationFailure(res);
    set((state) => ({
      byConnection: mapWorkspaces(state, connectionId, (list) => setWorkspaceDirs(list, id, res.data.dirs)),
    }));
    return { ok: true };
  },
}));

/** daemon error body → the line the page shows; shared so no surface invents its own. */
function mutationFailure(res: { status: number; data: unknown }): WorkspaceMutation {
  const { apiCode, message } = apiErrorOf(res.data);
  return { ok: false, error: friendlyMessage(apiCode, res.status, message) };
}

function mapSessions(
  state: SessionsState,
  connectionId: string,
  fn: (sessions: SessionDto[]) => SessionDto[],
): SessionsState['byConnection'] {
  const scope = state.byConnection[connectionId] ?? EMPTY_SCOPE;
  return { ...state.byConnection, [connectionId]: { ...scope, sessions: fn(scope.sessions) } };
}

function mapWorkspaces(
  state: SessionsState,
  connectionId: string,
  fn: (workspaces: WorkspaceDto[]) => WorkspaceDto[],
): SessionsState['byConnection'] {
  const scope = state.byConnection[connectionId] ?? EMPTY_SCOPE;
  return { ...state.byConnection, [connectionId]: { ...scope, workspaces: fn(scope.workspaces) } };
}

/** Read one connection's scope in a component. */
export function useScope(connectionId: string | null): ConnectionScope {
  return useSessions((state) => (connectionId ? state.byConnection[connectionId] : undefined)) ?? EMPTY_SCOPE;
}

/**
 * The sessions the rail may show: the loaded batch only counts when it was
 * fetched for `workspaceId`. A batch belonging to another workspace — left over
 * mid-switch, or the daemon's "every workspace" answer that used to arrive
 * before a workspace was chosen — must never render.
 */
export function visibleSessions(scope: ConnectionScope, workspaceId: string): SessionDto[] {
  return scope.sessionsWorkspaceId === workspaceId ? scope.sessions : [];
}
