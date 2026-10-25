/**
 * Every daemon path the client touches, in one place. The renderer's typed API
 * facade (renderer/src/ipc/client.ts) builds on these, so a path typo is a
 * compile error here rather than a runtime 404 there.
 */
export const ROUTES = {
  health: '/api/health',
  agents: '/api/agents',
  agent: '/api/agent',
  agentModels: (id: string) => `/api/agents/${encodeURIComponent(id)}/models`,
  workspaces: '/api/workspaces',
  workspace: (id: string) => `/api/workspaces/${encodeURIComponent(id)}`,
  workspaceDirs: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/dirs`,
  workspaceShortcuts: (id: string) => `/api/workspaces/${encodeURIComponent(id)}/shortcuts`,
  directories: '/api/fs/directories',
  config: '/api/config',
  files: '/api/files',
  fileContent: '/api/files/content',
  changes: '/api/changes',
  changesDiff: '/api/changes/diff',
  sessions: '/api/sessions',
  session: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
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
