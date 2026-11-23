import type { AgentRow, AgentThreadRow, Db, SessionAgentRow } from '../db/db.js';
import type { ProductPermissionMode } from '../permissions/permission-mode.js';
import type {
  Agent,
  AgentBudgetOverride,
  AgentKind,
  AgentThread,
} from './types.js';

/**
 * Domain-level access to agent rows.
 *
 * SQL lives in `db.ts` alongside every other table; this module owns the
 * row↔domain mapping so the rest of `agents/` never sees snake_case or
 * JSON-encoded columns.
 */

const KINDS: readonly AgentKind[] = ['builtin', 'runtime', 'peer'];
const CEILINGS: readonly ProductPermissionMode[] = ['ask', 'acceptEdits', 'bypass'];

export function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    summary: row.summary,
    avatar: row.avatar,
    kind: (KINDS as readonly string[]).includes(row.kind) ? (row.kind as AgentKind) : 'runtime',
    runtime: row.runtime,
    peerId: row.peer_id,
    remoteAgentId: row.remote_agent_id,
    model: row.model,
    modelParameters: parseJson<Record<string, string>>(row.model_parameters),
    instructions: row.instructions,
    cwd: row.cwd,
    extraDirs: parseJson<string[]>(row.extra_dirs) ?? [],
    readOnly: row.read_only === 1,
    permissionCeiling: (CEILINGS as readonly string[]).includes(row.permission_ceiling)
      ? (row.permission_ceiling as ProductPermissionMode)
      : 'ask',
    skills: parseJson<string[]>(row.skills),
    budget: parseJson<AgentBudgetOverride>(row.budget_json),
    heavy: row.heavy === 1,
    enabled: row.enabled === 1,
    version: row.version,
    isImplicit: row.is_implicit === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toThread(row: AgentThreadRow): AgentThread {
  const status = row.status === 'running' || row.status === 'broken' ? row.status : 'idle';
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    backend: row.backend,
    nativeSessionId: row.native_session_id,
    nativeThreadId: row.native_thread_id,
    remoteThreadKey: row.remote_thread_key,
    cwd: row.cwd,
    modelSnapshot: row.model_snapshot,
    agentVersion: row.agent_version,
    status,
    lastSeenSeq: row.last_seen_seq,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Domain → row for the editable half. `version` is decided by the service. */
export function toAgentRow(agent: Agent): AgentRow {
  return {
    id: agent.id,
    workspace_id: agent.workspaceId,
    name: agent.name,
    summary: agent.summary,
    avatar: agent.avatar,
    kind: agent.kind,
    runtime: agent.runtime,
    peer_id: agent.peerId,
    remote_agent_id: agent.remoteAgentId,
    model: agent.model,
    model_parameters: agent.modelParameters ? JSON.stringify(agent.modelParameters) : null,
    instructions: agent.instructions,
    cwd: agent.cwd,
    extra_dirs: agent.extraDirs.length > 0 ? JSON.stringify(agent.extraDirs) : null,
    read_only: agent.readOnly ? 1 : 0,
    permission_ceiling: agent.permissionCeiling,
    skills: agent.skills ? JSON.stringify(agent.skills) : null,
    budget_json: agent.budget ? JSON.stringify(agent.budget) : null,
    heavy: agent.heavy ? 1 : 0,
    is_implicit: agent.isImplicit ? 1 : 0,
    enabled: agent.enabled ? 1 : 0,
    version: agent.version,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

export function getAgent(db: Db, id: string): Agent | null {
  const row = db.getAgent(id);
  return row ? toAgent(row) : null;
}

export function listAgents(db: Db, workspaceId: string): Agent[] {
  return db.listAgents(workspaceId).map(toAgent);
}

export function listSessionAgents(db: Db, sessionId: string): { agent: Agent; role: SessionAgentRow['role'] }[] {
  const out: { agent: Agent; role: SessionAgentRow['role'] }[] = [];
  for (const row of db.listSessionAgents(sessionId)) {
    const agent = getAgent(db, row.agent_id);
    if (agent) out.push({ agent, role: row.role });
  }
  return out;
}

export function getLeader(db: Db, sessionId: string): Agent | null {
  const row = db.getSessionLeader(sessionId);
  if (!row) return null;
  return getAgent(db, row.agent_id);
}

export function listThreads(db: Db, sessionId: string): AgentThread[] {
  return db.listAgentThreads(sessionId).map(toThread);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
