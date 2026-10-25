import { ROUTES } from '../../../shared/routes';
import type {
  ConnectInput,
  DaemonRequest,
  DaemonResponse,
  StreamCancelInput,
  StreamSpec,
} from '../../../shared/ipc';
import type {
  AgentModelsResponse,
  AgentsResponse,
  ChangesResponse,
  ConfigResponse,
  DeleteWorkspaceResponse,
  DiffResponse,
  DirectoriesResponse,
  FileContentDto,
  FilesResponse,
  HealthDto,
  PermissionDecision,
  PermissionDto,
  PermissionGrantDto,
  ProductPermissionMode,
  RunNowResponse,
  RunRollbackResponse,
  ScheduledTaskDetailResponse,
  ScheduledTaskDto,
  ScheduledTasksResponse,
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  TaskConfigSessionResponse,
  SessionDetailResponse,
  SessionsResponse,
  UpdateSessionModelResponse,
  SseFrame,
  WorkspaceDirsResponse,
  WorkspaceResponse,
  WorkspaceShortcutsResponse,
  WorkspacesResponse,
} from '../../../shared/contract';

/**
 * The typed face of the daemon, over the single generic IPC proxy. Paths come
 * from shared/routes.ts so a typo fails the build here rather than 404ing at
 * runtime.
 */
/**
 * Which daemon API calls go to. Main holds several connections at once (§4), so
 * every request must name one; the connection store keeps this in step with the
 * host the rail and main area are scoped to. Kept here rather than threaded
 * through ~25 call sites that all target "whatever is on screen".
 */
let activeConnectionId: string | null = null;

export function setActiveConnectionId(id: string | null): void {
  activeConnectionId = id;
}

async function request<T>(req: Omit<DaemonRequest, 'connectionId'>): Promise<DaemonResponse<T>> {
  if (!activeConnectionId) {
    return { status: 0, ok: false, data: { error: 'not_connected', message: '尚未连接 daemon' } } as DaemonResponse<T>;
  }
  return (await window.paboot.request({ ...req, connectionId: activeConnectionId })) as DaemonResponse<T>;
}

export const connectionApi = {
  boot: () => window.paboot.boot(),
  get: () => window.paboot.connGet(),
  list: () => window.paboot.connList(),
  remove: (id: string) => window.paboot.connRemove(id),
  set: (input: ConnectInput) => window.paboot.connSet(input),
  clear: (id?: string) => window.paboot.connClear(id),
  probe: () => window.paboot.connProbe(),
  recent: () => window.paboot.recentList(),
  streamStart: (spec: StreamSpec) => window.paboot.streamStart(spec),
  streamCancel: (input: StreamCancelInput) => window.paboot.streamCancel(input),
};

export const api = {
  health: () => request<HealthDto>({ method: 'GET', path: ROUTES.health }),
  agents: () => request<AgentsResponse>({ method: 'GET', path: ROUTES.agents }),
  agentModels: (id: string) =>
    request<AgentModelsResponse>({ method: 'GET', path: ROUTES.agentModels(id) }),
  updateSessionModel: (id: string, model: string | null, modelParameters: Record<string, string> | null) =>
    request<UpdateSessionModelResponse>({
      method: 'PATCH',
      path: ROUTES.sessionModel(id),
      body: { model, modelParameters },
    }),
  workspaces: () => request<WorkspacesResponse>({ method: 'GET', path: ROUTES.workspaces }),
  config: () => request<ConfigResponse>({ method: 'GET', path: ROUTES.config }),
  updateConfig: (patch: { defaultPermissionMode?: ProductPermissionMode; defaultWorkspaceId?: string }) =>
    request<{ ok: boolean; config: ConfigResponse }>({ method: 'PATCH', path: ROUTES.config, body: patch }),
  createWorkspace: (path: string, name?: string) =>
    request<WorkspaceResponse>({
      method: 'POST',
      path: ROUTES.workspaces,
      body: name?.trim() ? { path, name } : { path },
    }),
  updateWorkspace: (id: string, patch: { name?: string; isDefault?: boolean; enabled?: boolean }) =>
    request<WorkspaceResponse>({ method: 'PATCH', path: ROUTES.workspace(id), body: patch }),
  deleteWorkspace: (id: string, cascade: boolean) =>
    request<DeleteWorkspaceResponse>({
      method: 'DELETE',
      path: ROUTES.workspace(id),
      query: cascade ? { cascade: 1 } : undefined,
    }),
  addWorkspaceDir: (id: string, path: string) =>
    request<WorkspaceDirsResponse>({ method: 'POST', path: ROUTES.workspaceDirs(id), body: { path } }),
  removeWorkspaceDir: (id: string, path: string) =>
    request<WorkspaceDirsResponse>({ method: 'DELETE', path: ROUTES.workspaceDirs(id), body: { path } }),
  addWorkspaceShortcut: (id: string, path: string) =>
    request<WorkspaceShortcutsResponse>({ method: 'POST', path: ROUTES.workspaceShortcuts(id), body: { path } }),
  removeWorkspaceShortcut: (id: string, path: string) =>
    request<WorkspaceShortcutsResponse>({ method: 'DELETE', path: ROUTES.workspaceShortcuts(id), body: { path } }),
  directories: (path?: string, showHidden?: boolean) =>
    request<DirectoriesResponse>({
      method: 'GET',
      path: ROUTES.directories,
      query: { path, showHidden },
    }),
  files: (params: {
    workspaceId?: string;
    root?: string;
    path?: string;
    cursor?: string;
    limit?: number;
    showHidden?: boolean;
    showIgnored?: boolean;
  }) => request<FilesResponse>({ method: 'GET', path: ROUTES.files, query: { ...params } }),
  fileContent: (params: { workspaceId?: string; root?: string; path: string }) =>
    request<FileContentDto>({ method: 'GET', path: ROUTES.fileContent, query: { ...params } }),
  changes: (params: { workspaceId?: string; root?: string; runId?: string }) =>
    request<ChangesResponse>({ method: 'GET', path: ROUTES.changes, query: { ...params } }),
  changesDiff: (params: { workspaceId?: string; root?: string; path: string; runId?: string }) =>
    request<DiffResponse>({ method: 'GET', path: ROUTES.changesDiff, query: { ...params } }),
  /** Destructive: restore the workspace to before `runId`. `force` also discards later runs. */
  runRollback: (runId: string, force = false) =>
    request<RunRollbackResponse>({
      method: 'POST',
      path: ROUTES.runRollback(runId),
      body: { confirm: true, force },
    }),
  sessions: (workspaceId?: string) =>
    request<SessionsResponse>({
      method: 'GET',
      path: ROUTES.sessions,
      query: { workspaceId },
    }),
  session: (id: string) =>
    request<SessionDetailResponse>({ method: 'GET', path: ROUTES.session(id) }),
  renameSession: (id: string, title: string) =>
    request<{ ok: boolean }>({ method: 'PATCH', path: ROUTES.session(id), body: { title } }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>({ method: 'DELETE', path: ROUTES.session(id) }),
  sessionPermissions: (sessionId: string) =>
    request<{ mode: ProductPermissionMode; grants: PermissionGrantDto[] }>({
      method: 'GET',
      path: ROUTES.sessionPermissions(sessionId),
    }),
  setSessionPermissionMode: (sessionId: string, mode: ProductPermissionMode) =>
    request<{ ok: boolean }>({
      method: 'PATCH',
      path: ROUTES.sessionPermissions(sessionId),
      body: { mode },
    }),
  revokePermissionGrant: (sessionId: string, toolName: string) =>
    request<{ ok: boolean }>({
      method: 'DELETE',
      path: ROUTES.sessionPermissionGrant(sessionId, toolName),
    }),
  revokeAllPermissionGrants: (sessionId: string) =>
    request<{ ok: boolean }>({ method: 'DELETE', path: ROUTES.sessionPermissionGrants(sessionId) }),
  runEvents: (runId: string, after?: number) =>
    request<{ runId: string; events: SseFrame[] }>({
      method: 'GET',
      path: ROUTES.runEvents(runId),
      query: { after },
    }),
  decidePermission: (
    permissionId: string,
    decision: PermissionDecision | 'allow_all',
    reason?: string,
    response?: unknown,
  ) =>
    request<{ ok: boolean; permission: PermissionDto }>({
      method: 'POST',
      path: ROUTES.permissionDecision(permissionId),
      // `response` only travels for UserInput answers; the daemon never stores it.
      body: response === undefined ? { decision, reason } : { decision, reason, response },
    }),
  scheduledTasks: (params?: { workspaceId?: string; sessionId?: string }) =>
    request<ScheduledTasksResponse>({ method: 'GET', path: ROUTES.scheduledTasks, query: { ...params } }),
  scheduledTask: (id: string) =>
    request<ScheduledTaskDetailResponse>({ method: 'GET', path: ROUTES.scheduledTask(id) }),
  createScheduledTask: (body: CreateScheduledTaskRequest) =>
    request<{ ok: boolean; task: ScheduledTaskDto }>({ method: 'POST', path: ROUTES.scheduledTasks, body }),
  updateScheduledTask: (id: string, patch: UpdateScheduledTaskRequest) =>
    request<{ ok: boolean; task: ScheduledTaskDto }>({
      method: 'PATCH',
      path: ROUTES.scheduledTask(id),
      body: patch,
    }),
  deleteScheduledTask: (id: string) =>
    request<{ ok: boolean; id: string }>({ method: 'DELETE', path: ROUTES.scheduledTask(id) }),
  runScheduledTaskNow: (id: string) =>
    request<RunNowResponse>({ method: 'POST', path: ROUTES.scheduledTaskRunNow(id) }),
  startTaskConfigSession: (body: { workspaceId?: string; runtime?: string }) =>
    request<TaskConfigSessionResponse>({ method: 'POST', path: ROUTES.taskConfigSession, body }),
};
