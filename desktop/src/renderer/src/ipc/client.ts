import { ROUTES } from '../../../shared/routes';
import type {
  AppPrefs,
  AttachmentGetResult,
  AttachmentUploadResult,
  ConnectInput,
  DaemonRequest,
  DaemonResponse,
  KnowledgeExportResult,
  ManagedDaemonStartInput,
  ManagedDaemonStartResult,
  RevealResult,
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
  CreateKnowledgeDocRequest,
  DeleteKnowledgeDocResponse,
  KnowledgeDocResponse,
  KnowledgeDocsResponse,
  KnowledgeVerifyResponse,
  UpdateKnowledgeDocRequest,
  EndResponse,
  EndSuggestionsResponse,
  EndsResponse,
  CapabilityDeviceListDto,
  MemoryBriefDto,
  MemoryClaimDto,
  MockModelDto,
  MockModelResponse,
  MemoryClaimResponse,
  MemoryClaimsResponse,
  MemoryCorrectClaimRequest,
  MemoryRememberRequest,
  MemoryDisputesResponse,
  MemoryDisputeResolveResponse,
  MemoryDuplicatesResponse,
  MemoryEntitiesResponse,
  MemoryEntityLinkResponse,
  MemoryEntityLinksResponse,
  MemoryEntityResponse,
  MemorySearchResponse,
  MemorySessionModeRequest,
  MemoryStatusDto,
  MemoryTimelineResponse,
  WorkspaceMemoryDto,
  PermissionDecision,
  PermissionDto,
  PermissionGrantDto,
  ProductPermissionMode,
  ProviderDto,
  ProvidersResponse,
  ProviderResponse,
  ProviderTestResponse,
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

/**
 * Reveal a file / open a directory on the daemon's machine. Main re-checks both
 * "local daemon" and "path exists", so a stale menu cannot bypass either.
 */
export function revealPath(path: string, kind: 'file' | 'directory'): Promise<RevealResult> {
  if (!activeConnectionId) {
    return Promise.resolve({ ok: false, code: 'not_connected', message: '尚未连接 daemon' });
  }
  return window.paboot.revealPath({ connectionId: activeConnectionId, path, kind });
}

export function exportKnowledge(
  workspaceId: string,
  suggestedName?: string,
): Promise<KnowledgeExportResult> {
  if (!activeConnectionId) {
    return Promise.resolve({ ok: false, code: 'not_connected', message: '尚未连接 daemon' });
  }
  return window.paboot.knowledgeExport({ connectionId: activeConnectionId, workspaceId, suggestedName });
}

export function uploadAttachment(
  bytes: Uint8Array,
  contentType: string,
): Promise<AttachmentUploadResult> {
  if (!activeConnectionId) {
    return Promise.resolve({
      status: 0,
      ok: false,
      data: { error: 'not_connected', message: '尚未连接 daemon' },
    });
  }
  return window.paboot.uploadAttachment({ connectionId: activeConnectionId, bytes, contentType });
}

export function attachmentBytes(id: string): Promise<AttachmentGetResult> {
  if (!activeConnectionId) {
    return Promise.resolve({
      status: 0,
      ok: false,
      contentType: null,
      data: null,
      error: { error: 'not_connected', message: '尚未连接 daemon' },
    });
  }
  return window.paboot.attachmentBytes({ connectionId: activeConnectionId, id });
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
  prefsGet: (): Promise<AppPrefs> => window.paboot.prefsGet(),
  daemonStart: (input: ManagedDaemonStartInput): Promise<ManagedDaemonStartResult> =>
    window.paboot.daemonStart(input),
};

export const api = {
  health: () => request<HealthDto>({ method: 'GET', path: ROUTES.health }),
  agents: () => request<AgentsResponse>({ method: 'GET', path: ROUTES.agents }),
  agentModels: (id: string) =>
    request<AgentModelsResponse>({ method: 'GET', path: ROUTES.agentModels(id) }),
  providers: () => request<ProvidersResponse>({ method: 'GET', path: ROUTES.providers }),
  createProvider: (body: {
    id: string;
    kind: 'anthropic' | 'openai';
    label?: string;
    baseUrl: string;
    apiKey?: string | null;
    models?: ProviderDto['models'];
  }) => request<ProviderResponse>({ method: 'POST', path: ROUTES.providers, body }),
  updateProvider: (id: string, body: {
    kind?: 'anthropic' | 'openai';
    label?: string;
    baseUrl?: string;
    apiKey?: string | null;
    models?: ProviderDto['models'];
  }) => request<ProviderResponse>({ method: 'PATCH', path: ROUTES.provider(id), body }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean; id: string }>({ method: 'DELETE', path: ROUTES.provider(id) }),
  testProvider: (id: string) =>
    request<ProviderTestResponse>({ method: 'POST', path: ROUTES.providerTest(id) }),
  refreshProviderModels: (id: string) =>
    request<ProviderResponse>({ method: 'POST', path: ROUTES.providerModelsRefresh(id) }),
  updateSessionModel: (id: string, model: string | null, modelParameters: Record<string, string> | null) =>
    request<UpdateSessionModelResponse>({
      method: 'PATCH',
      path: ROUTES.sessionModel(id),
      body: { model, modelParameters },
    }),
  workspaces: () => request<WorkspacesResponse>({ method: 'GET', path: ROUTES.workspaces }),
  config: () => request<ConfigResponse>({ method: 'GET', path: ROUTES.config }),
  updateConfig: (patch: {
    defaultPermissionMode?: ProductPermissionMode;
    defaultWorkspaceId?: string;
    memoryModel?: string | null;
  }) =>
    request<{ ok: boolean; config: ConfigResponse }>({ method: 'PATCH', path: ROUTES.config, body: patch }),
  createWorkspace: (path: string, name?: string) =>
    request<WorkspaceResponse>({
      method: 'POST',
      path: ROUTES.workspaces,
      body: name?.trim() ? { path, name } : { path },
    }),
  updateWorkspace: (
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      defaultRuntime?: string | null;
      defaultPermissionMode?: ProductPermissionMode | null;
    },
  ) =>
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
  knowledge: (
    workspaceId: string,
    filter?: { endId?: string; kind?: string; status?: string; verified?: boolean; q?: string },
  ) =>
    request<KnowledgeDocsResponse>({
      method: 'GET',
      path: ROUTES.knowledge(workspaceId),
      query: { ...filter },
    }),
  knowledgeDoc: (workspaceId: string, kid: string) =>
    request<KnowledgeDocResponse>({ method: 'GET', path: ROUTES.knowledgeDoc(workspaceId, kid) }),
  createKnowledgeDoc: (workspaceId: string, body: CreateKnowledgeDocRequest) =>
    request<KnowledgeDocResponse>({ method: 'POST', path: ROUTES.knowledge(workspaceId), body }),
  updateKnowledgeDoc: (workspaceId: string, kid: string, body: UpdateKnowledgeDocRequest) =>
    request<KnowledgeDocResponse>({
      method: 'PATCH',
      path: ROUTES.knowledgeDoc(workspaceId, kid),
      body,
    }),
  verifyKnowledgeDoc: (workspaceId: string, kid: string, verified: boolean) =>
    request<KnowledgeVerifyResponse>({
      method: 'POST',
      path: ROUTES.knowledgeVerify(workspaceId, kid),
      body: { verified },
    }),
  deleteKnowledgeDoc: (workspaceId: string, kid: string) =>
    request<DeleteKnowledgeDocResponse>({
      method: 'DELETE',
      path: ROUTES.knowledgeDoc(workspaceId, kid),
    }),
  memoryBrief: (scope: string) =>
    request<MemoryBriefDto>({ method: 'GET', path: ROUTES.memoryBrief, query: { scope } }),
  memoryClaims: (scope: string) =>
    request<MemoryClaimsResponse>({ method: 'GET', path: ROUTES.memoryClaims, query: { scope } }),
  memoryClaim: (scope: string, id: string) =>
    request<MemoryClaimResponse>({
      method: 'GET',
      path: ROUTES.memoryClaim(id),
      query: { scope },
    }),
  correctMemoryClaim: (scope: string, id: string, body: MemoryCorrectClaimRequest) =>
    request<MemoryClaimResponse>({
      method: 'PATCH',
      path: ROUTES.memoryClaim(id),
      query: { scope },
      body,
    }),
  forgetMemoryClaim: (scope: string, id: string) =>
    request<{ ok: true; id: string }>({
      method: 'DELETE',
      path: ROUTES.memoryClaim(id),
      query: { scope },
    }),
  memoryStatus: (scope: string) =>
    request<MemoryStatusDto>({ method: 'GET', path: ROUTES.memoryStatus, query: { scope } }),
  memoryFeedback: (scope: string, body: { targetId: string; action: string; note?: string }) =>
    request<{ ok: true }>({
      method: 'POST',
      path: ROUTES.memoryFeedback,
      query: { scope },
      body: { targetType: 'claim', ...body },
    }),
  rememberMessage: (body: MemoryRememberRequest) =>
    request<{ ok: true; sourceId: string }>({ method: 'POST', path: ROUTES.memoryRemember, body }),
  setSessionMemoryMode: (body: MemorySessionModeRequest) =>
    request<{ sessionId: string; mode: string }>({
      method: 'PATCH',
      path: ROUTES.memorySession,
      body,
    }),
  memorySearch: (scope: string, q: string, files?: string) =>
    request<MemorySearchResponse>({
      method: 'GET',
      path: ROUTES.memorySearch,
      query: files ? { scope, q, files } : { scope, q },
    }),
  memoryTimeline: (scope: string) =>
    request<MemoryTimelineResponse>({ method: 'GET', path: ROUTES.memoryTimeline, query: { scope } }),
  memoryDuplicates: (scope: string, status = 'pending') =>
    request<MemoryDuplicatesResponse>({
      method: 'GET',
      path: ROUTES.memoryDuplicates,
      query: { scope, status },
    }),
  resolveMemoryDuplicate: (
    scope: string,
    id: string,
    action: 'merge' | 'distinct' | 'dismiss',
  ) =>
    request<{ ok: boolean; claim?: MemoryClaimDto }>({
      method: 'POST',
      path: ROUTES.memoryDuplicate(id),
      query: { scope },
      body: { action },
    }),
  memoryDisputes: (scope: string) =>
    request<MemoryDisputesResponse>({
      method: 'GET',
      path: ROUTES.memoryDisputes,
      query: { scope },
    }),
  resolveMemoryDispute: (
    scope: string,
    newId: string,
    oldId: string,
    keep: 'new' | 'old',
  ) =>
    request<MemoryDisputeResolveResponse>({
      method: 'POST',
      path: ROUTES.memoryDisputeResolve(newId),
      query: { scope },
      body: { oldId, keep },
    }),
  memoryEntities: (scope: string, status: 'active' | 'merged' = 'active') =>
    request<MemoryEntitiesResponse>({
      method: 'GET',
      path: ROUTES.memoryEntities,
      query: { scope, status },
    }),
  mergeMemoryEntity: (scope: string, id: string, mergeInto: string) =>
    request<MemoryEntityResponse>({
      method: 'PATCH',
      path: ROUTES.memoryEntity(id),
      query: { scope },
      body: { mergeInto },
    }),
  unmergeMemoryEntity: (scope: string, id: string) =>
    request<MemoryEntityResponse>({
      method: 'POST',
      path: ROUTES.memoryEntityUnmerge(id),
      query: { scope },
    }),
  memoryEntityLinks: (scope: string) =>
    request<MemoryEntityLinksResponse>({
      method: 'GET',
      path: ROUTES.memoryEntityLinks,
      query: { scope },
    }),
  linkMemoryEntities: (scope: string, a: string, b: string) =>
    request<MemoryEntityLinkResponse>({
      method: 'POST',
      path: ROUTES.memoryEntityLinks,
      query: { scope },
      body: { a, b },
    }),
  unlinkMemoryEntities: (scope: string, a: string, b: string) =>
    request<{ ok: boolean }>({
      method: 'DELETE',
      path: ROUTES.memoryEntityLinks,
      query: { scope, a, b },
    }),
  promoteMemoryClaim: (scope: string, id: string, shareClass: 'portable' | 'personal' | 'life_only') =>
    request<MemoryClaimResponse>({
      method: 'POST',
      path: ROUTES.memoryClaimPromote(id),
      query: { scope },
      body: { shareClass },
    }),
  workspaceMemory: (id: string) =>
    request<WorkspaceMemoryDto>({ method: 'GET', path: ROUTES.workspaceMemory(id) }),
  workspaceEnds: (id: string) =>
    request<EndsResponse>({ method: 'GET', path: ROUTES.workspaceEnds(id) }),
  endSuggestions: (id: string) =>
    request<EndSuggestionsResponse>({ method: 'GET', path: ROUTES.workspaceEndSuggestions(id) }),
  createWorkspaceEnd: (id: string, name: string) =>
    request<EndResponse>({
      method: 'POST',
      path: ROUTES.workspaceEnds(id),
      body: { name },
    }),
  bindEndRoot: (id: string, endId: string, root: string) =>
    request<EndResponse>({
      method: 'POST',
      path: ROUTES.workspaceEndRoots(id, endId),
      body: { path: root },
    }),
  unbindEndRoot: (id: string, endId: string, root: string) =>
    request<EndResponse>({
      method: 'DELETE',
      path: ROUTES.workspaceEndRoots(id, endId),
      body: { path: root },
    }),
  deleteWorkspaceEnd: (id: string, endId: string) =>
    request<{ ok: boolean }>({ method: 'DELETE', path: ROUTES.workspaceEnd(id, endId) }),
  activateEnd: (id: string, endId: string) =>
    request<EndResponse>({ method: 'POST', path: ROUTES.workspaceEndActivate(id, endId) }),
  deviceList: (id: string, endId?: string) =>
    request<CapabilityDeviceListDto>({
      method: 'GET',
      path: ROUTES.workspaceDevice(id),
      query: endId ? { endId } : undefined,
    }),
  selectDevice: (id: string, endId: string, serial: string) =>
    request<{ ok: boolean }>({
      method: 'POST',
      path: ROUTES.workspaceDeviceSelect(id),
      body: { endId, serial },
    }),
  deviceAction: <T = unknown>(id: string, body: Record<string, unknown>) =>
    request<T>({
      method: 'POST',
      path: ROUTES.workspaceDeviceAction(id),
      body,
    }),
  workspaceMock: (id: string) =>
    request<MockModelResponse>({ method: 'GET', path: ROUTES.workspaceMock(id) }),
  saveWorkspaceMock: (id: string, model: MockModelDto, remove: string[] = []) =>
    request<MockModelResponse>({
      method: 'PUT',
      path: ROUTES.workspaceMock(id),
      body: { ...model, remove },
    }),
  updateWorkspaceMemory: (
    id: string,
    patch: {
      enabled?: boolean;
      injectionEnabled?: boolean;
      profileMode?: 'off' | 'portable' | 'full';
      lifeReadable?: boolean;
      providerOverride?: string | null;
    },
  ) =>
    request<WorkspaceMemoryDto>({
      method: 'PATCH',
      path: ROUTES.workspaceMemory(id),
      body: patch,
    }),
};
