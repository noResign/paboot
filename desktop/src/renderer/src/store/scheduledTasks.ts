import { create } from 'zustand';
import { api } from '../ipc/client';
import type {
  CreateScheduledTaskRequest,
  ScheduledTaskDetailResponse,
  ScheduledTaskDto,
  TaskConfigSessionResponse,
  UpdateScheduledTaskRequest,
} from '../../../shared/contract';

interface TaskScope {
  tasks: ScheduledTaskDto[];
  loading: boolean;
  error: string | null;
  detail: ScheduledTaskDetailResponse | null;
}

const EMPTY_SCOPE: TaskScope = { tasks: [], loading: false, error: null, detail: null };

export type TaskMutation<T = ScheduledTaskDto> = { ok: true; task: T } | { ok: false; error: string };

function messageOf(data: unknown): string {
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; message?: unknown };
    if (typeof record.error === 'string' && record.error) return record.error;
    if (typeof record.message === 'string' && record.message) return record.message;
  }
  return '请求失败';
}

interface TasksState {
  byConnection: Record<string, TaskScope>;
  load(
    connectionId: string,
    workspaceId?: string,
    options?: { silent?: boolean; sessionId?: string },
  ): Promise<void>;
  loadDetail(connectionId: string, id: string): Promise<void>;
  create(connectionId: string, body: CreateScheduledTaskRequest): Promise<TaskMutation>;
  update(connectionId: string, id: string, patch: UpdateScheduledTaskRequest): Promise<TaskMutation>;
  remove(connectionId: string, id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  runNow(connectionId: string, id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  startConfigSession(
    connectionId: string,
    workspaceId?: string,
    runtime?: string,
  ): Promise<
    | { ok: true; sessionId: string; runId: string | null; busy: boolean }
    | { ok: false; error: string }
  >;
}

export const useScheduledTasks = create<TasksState>((set) => ({
  byConnection: {},

  async load(connectionId, workspaceId, options) {
    if (!options?.silent) {
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...(state.byConnection[connectionId] ?? EMPTY_SCOPE), loading: true, error: null },
        },
      }));
    }
    const response = await api.scheduledTasks({ workspaceId, sessionId: options?.sessionId });
    set((state) => {
      const current = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      if (!response.ok) {
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: { ...current, loading: false, error: messageOf(response.data) },
          },
        };
      }
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...current,
            loading: false,
            error: null,
            tasks: (response.data as { tasks: ScheduledTaskDto[] }).tasks,
          },
        },
      };
    });
  },

  async loadDetail(connectionId, id) {
    const response = await api.scheduledTask(id);
    set((state) => {
      const current = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...current,
            detail: response.ok ? (response.data as ScheduledTaskDetailResponse) : null,
          },
        },
      };
    });
  },

  async create(connectionId, body) {
    const response = await api.createScheduledTask(body);
    if (!response.ok) return { ok: false, error: messageOf(response.data) };
    const task = (response.data as { task: ScheduledTaskDto }).task;
    set((state) => {
      const current = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...current, tasks: [task, ...current.tasks] },
        },
      };
    });
    return { ok: true, task };
  },

  async update(connectionId, id, patch) {
    const response = await api.updateScheduledTask(id, patch);
    if (!response.ok) return { ok: false, error: messageOf(response.data) };
    const task = (response.data as { task: ScheduledTaskDto }).task;
    set((state) => {
      const current = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...current,
            tasks: current.tasks.map((item) => (item.id === id ? task : item)),
            detail: current.detail?.task.id === id ? { ...current.detail, task } : current.detail,
          },
        },
      };
    });
    return { ok: true, task };
  },

  async remove(connectionId, id) {
    const response = await api.deleteScheduledTask(id);
    if (!response.ok) return { ok: false, error: messageOf(response.data) };
    set((state) => {
      const current = state.byConnection[connectionId] ?? EMPTY_SCOPE;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...current,
            tasks: current.tasks.filter((item) => item.id !== id),
            detail: current.detail?.task.id === id ? null : current.detail,
          },
        },
      };
    });
    return { ok: true };
  },

  async runNow(_connectionId, id) {
    const response = await api.runScheduledTaskNow(id);
    if (!response.ok) return { ok: false, error: messageOf(response.data) };
    return { ok: true };
  },

  async startConfigSession(_connectionId, workspaceId, runtime) {
    const response = await api.startTaskConfigSession({ workspaceId, runtime });
    if (!response.ok) return { ok: false, error: messageOf(response.data) };
    const data = response.data as TaskConfigSessionResponse;
    return { ok: true, sessionId: data.sessionId, runId: data.runId, busy: data.busy };
  },
}));
