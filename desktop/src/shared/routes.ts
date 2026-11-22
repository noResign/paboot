/**
 * Every daemon path the client touches, in one place. The renderer's typed API
 * facade (renderer/src/ipc/client.ts) builds on these, so a path typo is a
 * compile error here rather than a runtime 404 there.
 */
export const ROUTES = {
  health: '/api/health',
  agents: '/api/agents',
  providers: '/api/providers',
  provider: (id: string) => `/api/providers/${encodeURIComponent(id)}`,
  providerTest: (id: string) => `/api/providers/${encodeURIComponent(id)}/test`,
  providerModelsRefresh: (id: string) => `/api/providers/${encodeURIComponent(id)}/models/refresh`,
  agent: '/api/agent',
  agentModels: (id: string) => `/api/agents/${encodeURIComponent(id)}/models`,
  // Agent profiles（会话里的「助手」）——与上面 `agents`（runtime 插件清单）区分：
  // 那个列的是能驱动的后端，这个管的是房间里干活的那个助手。
  workspaceAgents: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/agents`,
  agentProfiles: (id: string) => `/api/agent-profiles/${encodeURIComponent(id)}`,
  sessionAgents: (id: string) => `/api/sessions/${encodeURIComponent(id)}/agents`,
  sessionAgent: (id: string, agentId: string) =>
    `/api/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`,
  sessionAgentReset: (id: string, agentId: string) =>
    `/api/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/reset-context`,
  workspaces: '/api/workspaces',
  workspace: (id: string) => `/api/workspaces/${encodeURIComponent(id)}`,
  workspaceDirs: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/dirs`,
  workspaceShortcuts: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/shortcuts`,
  knowledge: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/knowledge`,
  knowledgeDoc: (id: string, kid: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/knowledge/${encodeURIComponent(kid)}`,
  knowledgeVerify: (id: string, kid: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/knowledge/${encodeURIComponent(kid)}/verify`,
  knowledgeExport: (id: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/knowledge/export`,
  memoryBrief: '/api/memory/brief',
  memoryClaims: '/api/memory/claims',
  memoryClaim: (id: string) => `/api/memory/claims/${encodeURIComponent(id)}`,
  memoryStatus: '/api/memory/status',
  memoryFeedback: '/api/memory/feedback',
  memoryRemember: '/api/memory/remember',
  memorySession: '/api/memory/session',
  memorySearch: '/api/memory/search',
  memoryTimeline: '/api/memory/timeline',
  memoryDuplicates: '/api/memory/duplicates',
  memoryDuplicate: (id: string) =>
    `/api/memory/duplicates/${encodeURIComponent(id)}`,
  memoryDisputes: '/api/memory/disputes',
  memoryDisputeResolve: (newId: string) =>
    `/api/memory/disputes/${encodeURIComponent(newId)}/resolve`,
  memoryEntities: '/api/memory/entities',
  memoryEntity: (id: string) => `/api/memory/entities/${encodeURIComponent(id)}`,
  memoryEntityUnmerge: (id: string) =>
    `/api/memory/entities/${encodeURIComponent(id)}/unmerge`,
  memoryEntityLinks: '/api/memory/entity-links',
  memoryLoops: '/api/memory/loops',
  memoryLoop: (id: string) => `/api/memory/loops/${encodeURIComponent(id)}`,
  memorySource: (id: string) => `/api/memory/sources/${encodeURIComponent(id)}`,
  memoryClaimPromote: (id: string) =>
    `/api/memory/claims/${encodeURIComponent(id)}/promote`,
  workspaceMemory: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/memory`,
  workspaceEnds: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/ends`,
  workspaceEndSuggestions: (id: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/end-suggestions`,
  workspaceEnd: (id: string, endId: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/ends/${encodeURIComponent(endId)}`,
  workspaceEndRoots: (id: string, endId: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/ends/${encodeURIComponent(endId)}/roots`,
  workspaceEndActivate: (id: string, endId: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/ends/${encodeURIComponent(endId)}/activate`,
  sessionEnds: (id: string) => `/api/sessions/${encodeURIComponent(id)}/ends`,
  workspaceEndImpact: (id: string, endId: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/ends/${encodeURIComponent(endId)}/impact`,
  workspaceEndArchive: (id: string, endId: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/ends/${encodeURIComponent(endId)}/archive`,
  workspaceEndRestore: (id: string, endId: string) =>
    `/api/workspaces/${encodeURIComponent(id)}/ends/${encodeURIComponent(endId)}/restore`,
  directories: '/api/fs/directories',
  config: '/api/config',
  files: '/api/files',
  fileContent: '/api/files/content',
  fileRaw: '/api/files/raw',
  changes: '/api/changes',
  changesDiff: '/api/changes/diff',
  sessions: '/api/sessions',
  session: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
  sessionEvents: (id: string) => `/api/sessions/${encodeURIComponent(id)}/events`,
  /** 房间流：一个会话里所有 agent 的帧，一个游标。 */
  sessionStream: (id: string) => `/api/sessions/${encodeURIComponent(id)}/stream`,
  /** 发一次输入：202 + 任务列表，答案是走房间流的。 */
  sessionTurns: (id: string) => `/api/sessions/${encodeURIComponent(id)}/turns`,
  /** 停止该会话当前所有 room 任务。 */
  sessionCancel: (id: string) => `/api/sessions/${encodeURIComponent(id)}/cancel`,
  sessionModel: (id: string) => `/api/sessions/${encodeURIComponent(id)}/model`,
  runs: '/api/runs',
  run: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
  runStream: (id: string) => `/api/runs/${encodeURIComponent(id)}/stream`,
  runCancel: (id: string) => `/api/runs/${encodeURIComponent(id)}/cancel`,
  runRollback: (id: string) => `/api/runs/${encodeURIComponent(id)}/rollback`,
  runEvents: (id: string) => `/api/runs/${encodeURIComponent(id)}/events`,
  chat: '/api/chat',
  permissions: '/api/permissions',
  permissionDecision: (id: string) => `/api/permissions/${encodeURIComponent(id)}/decision`,
  sessionPermissions: (id: string) => `/api/sessions/${encodeURIComponent(id)}/permissions`,
  sessionPermissionGrants: (id: string) => `/api/sessions/${encodeURIComponent(id)}/permissions/grants`,
  sessionPermissionGrant: (id: string, toolName: string) =>
    `/api/sessions/${encodeURIComponent(id)}/permissions/grants/${encodeURIComponent(toolName)}`,
  scheduledTasks: '/api/scheduled-tasks',
  scheduledTask: (id: string) => `/api/scheduled-tasks/${encodeURIComponent(id)}`,
  scheduledTaskRunNow: (id: string) => `/api/scheduled-tasks/${encodeURIComponent(id)}/run-now`,
  taskConfigSession: '/api/scheduled-tasks/config-session',
} as const;
