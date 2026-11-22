import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Db, WorkspaceRow } from '../db/db.js';
import type { ProductPermissionMode } from '../permissions/permission-mode.js';
import { workspaceContains } from '../workspaces/workspace-service.js';
import {
  getAgent,
  getLeader,
  listAgents,
  listSessionAgents,
  listThreads,
  toAgent,
  toAgentRow,
  toThread,
} from './store.js';
import type {
  Agent,
  AgentThread,
  CreateAgentInput,
  UpdateAgentInput,
} from './types.js';

/**
 * Agent lifecycle: validation, version bumps, and the delete cascade.
 *
 * Two rules drive most of this file:
 *   1. A name is the `@` handle, so it must be unique per workspace and
 *      case-insensitively so (`@Review` and `@review` are one person).
 *   2. Paths are capability, not configuration: an agent's `cwd` and extra dirs
 *      must stay inside its workspace. A path that escapes is refused at write
 *      time rather than silently trimmed, because a silently narrowed path
 *      looks like "the agent cannot see my file" later.
 */

export class AgentValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentValidationError';
  }
}

export const MAX_SUMMARY_CHARS = 40;
const MAX_INSTRUCTIONS_CHARS = 20_000;
/** `@all` / `@全体` are routing keywords, so they cannot also be agent names. */
const RESERVED_MENTION_NAMES = new Set(['all', '全体']);

export function createAgent(
  db: Db,
  workspace: WorkspaceRow,
  input: CreateAgentInput,
): Agent {
  const kind = input.kind;
  const name = normalizeName(input.name);
  if (!name) throw new AgentValidationError('invalid_name', 'name must not be empty');
  if (RESERVED_MENTION_NAMES.has(name.toLowerCase())) {
    throw new AgentValidationError('reserved_name', `"${name}" is reserved for room-wide mentions`);
  }
  if (db.agentNameConflict(workspace.id, name, null)) {
    throw new AgentValidationError('name_taken', `an agent named "${name}" already exists`);
  }

  const summary = normalizeSummary(input.summary);
  const instructions = normalizeInstructions(input.instructions);
  const paths = normalizePaths(workspace, input.cwd, input.extraDirs);
  const wiring = normalizeWiring(kind, input.runtime ?? null, input.peerId ?? null, input.remoteAgentId ?? null);

  const now = Date.now();
  const agent: Agent = {
    id: `ag_${randomUUID()}`,
    workspaceId: workspace.id,
    name,
    summary,
    avatar: input.avatar ?? null,
    kind,
    runtime: wiring.runtime,
    peerId: wiring.peerId,
    remoteAgentId: wiring.remoteAgentId,
    model: input.model ?? null,
    modelParameters: input.modelParameters ?? null,
    instructions,
    cwd: paths.cwd,
    extraDirs: paths.extraDirs,
    readOnly: input.readOnly ?? false,
    permissionCeiling: normalizeCeiling(input.permissionCeiling, kind),
    toolsAllow: input.toolsAllow ?? null,
    toolsDeny: input.toolsDeny ?? null,
    skills: input.skills ?? null,
    budget: input.budget ?? null,
    heavy: input.heavy ?? false,
    enabled: input.enabled ?? true,
    version: 1,
    isImplicit: false,
    createdAt: now,
    updatedAt: now,
  };
  db.insertAgent(toAgentRow(agent));
  return agent;
}

export function updateAgent(db: Db, workspace: WorkspaceRow, id: string, patch: UpdateAgentInput): Agent {
  const current = getAgent(db, id);
  if (!current) throw new AgentValidationError('not_found', `no agent ${id}`);

  // Turning an existing read-only member into a writer changes room
  // membership semantics, not just this agent definition. Re-check the same
  // invariant the add-member endpoint enforces.
  if (current.readOnly && patch.readOnly === false) {
    for (const sessionId of db.listSessionsForAgent(id)) {
      assertWritableSlotFree(db, sessionId, { ...current, readOnly: false });
    }
  }

  let name = current.name;
  if (patch.name !== undefined) {
    name = normalizeName(patch.name);
    if (!name) throw new AgentValidationError('invalid_name', 'name must not be empty');
    if (RESERVED_MENTION_NAMES.has(name.toLowerCase())) {
      throw new AgentValidationError('reserved_name', `"${name}" is reserved for room-wide mentions`);
    }
    if (db.agentNameConflict(workspace.id, name, id)) {
      throw new AgentValidationError('name_taken', `an agent named "${name}" already exists`);
    }
  }

  const paths =
    patch.cwd !== undefined || patch.extraDirs !== undefined
      ? normalizePaths(
          workspace,
          patch.cwd !== undefined ? patch.cwd : current.cwd,
          patch.extraDirs !== undefined ? patch.extraDirs : current.extraDirs,
        )
      : { cwd: current.cwd, extraDirs: current.extraDirs };

  const next: Agent = {
    ...current,
    name,
    summary: patch.summary !== undefined ? normalizeSummary(patch.summary) : current.summary,
    avatar: patch.avatar !== undefined ? patch.avatar : current.avatar,
    model: patch.model !== undefined ? patch.model : current.model,
    modelParameters:
      patch.modelParameters !== undefined ? patch.modelParameters : current.modelParameters,
    instructions:
      patch.instructions !== undefined ? normalizeInstructions(patch.instructions) : current.instructions,
    cwd: paths.cwd,
    extraDirs: paths.extraDirs,
    readOnly: patch.readOnly !== undefined ? patch.readOnly : current.readOnly,
    permissionCeiling:
      patch.permissionCeiling !== undefined
        ? normalizeCeiling(patch.permissionCeiling, current.kind)
        : current.permissionCeiling,
    toolsAllow: patch.toolsAllow !== undefined ? patch.toolsAllow : current.toolsAllow,
    toolsDeny: patch.toolsDeny !== undefined ? patch.toolsDeny : current.toolsDeny,
    skills: patch.skills !== undefined ? patch.skills : current.skills,
    budget: patch.budget !== undefined ? patch.budget : current.budget,
    heavy: patch.heavy !== undefined ? patch.heavy : current.heavy,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    version: current.version + 1,
    updatedAt: Date.now(),
  };
  db.updateAgentRow(id, toAgentRow(next));

  // A cwd change invalidates every existing thread's working directory; the
  // conversation may still be resumable, but it must run where the agent now
  // points. Threads stay open (no native id reset) — only the path moves.
  if (paths.cwd !== current.cwd) {
    for (const sessionId of db.listSessionsForAgent(id)) {
      const thread = db.getAgentThread(sessionId, id);
      if (thread) db.updateAgentThread(thread.id, { cwd: paths.cwd ?? workspace.path });
    }
  }
  return next;
}

/**
 * Remove an agent and everything that referenced it.
 *
 * A leader cannot be removed silently: the room would lose its default speaker
 * with no successor. Callers must hand the room to someone else first.
 */
export function removeAgent(db: Db, id: string): void {
  const agent = getAgent(db, id);
  if (!agent) throw new AgentValidationError('not_found', `no agent ${id}`);

  const sessions = db.listSessionsForAgent(id);
  for (const sessionId of sessions) {
    if (getLeader(db, sessionId)?.id === id) {
      throw new AgentValidationError(
        'leader_required',
        'this agent is a room leader; hand the room to another agent before removing it',
      );
    }
  }

  for (const sessionId of sessions) {
    // Cancel first, then drop the membership: a running task holds the thread,
    // and deleting rows under it would leave telemetry pointing at nothing.
    for (const thread of listThreads(db, sessionId).filter((item) => item.agentId === id)) {
      db.updateAgentThread(thread.id, { status: 'broken' });
    }
    db.deleteSessionAgent(sessionId, id);
  }
  // Threads outlive the agent on purpose: history stays readable, and the
  // status flip above is what stops it from ever speaking again.
  db.deleteAgentRow(id);
}

/** Agents in a session, leader first. */
export function sessionRoster(db: Db, sessionId: string): { agent: Agent; role: 'leader' | 'member' }[] {
  return listSessionAgents(db, sessionId);
}

/**
 * Attach an agent to a room without a leader (the first member becomes leader).
 * Re-adding an existing member is a no-op so clients can be optimistic.
 */
export function addToSession(db: Db, session: { id: string; workspaceId: string | null }, agentId: string): void {
  const agent = getAgent(db, agentId);
  if (!agent) throw new AgentValidationError('not_found', `no agent ${agentId}`);
  if (session.workspaceId && agent.workspaceId !== session.workspaceId) {
    throw new AgentValidationError('cross_workspace', 'the agent belongs to another workspace');
  }
  const existing = db.listSessionAgents(session.id);
  if (existing.some((row) => row.agent_id === agentId)) return;
  db.upsertSessionAgent({
    session_id: session.id,
    agent_id: agentId,
    role: existing.length === 0 ? 'leader' : 'member',
    added_by: null,
    joined_at: Date.now(),
  });
}

/**
 * The thread an agent runs in for a session, created on first use.
 *
 * Backend and cwd come from the agent, not the session: two agents in one room
 * may run different runtimes from different directories, and the thread is what
 * remembers that. `modelSnapshot`/`agentVersion` record what the conversation
 * was opened under so later edits are visible as drift rather than silence.
 */
export function ensureThread(
  db: Db,
  session: { id: string },
  agent: Agent,
  workspace: WorkspaceRow,
): AgentThread {
  const backend = agent.kind === 'builtin' ? 'builtin' : agent.kind === 'peer' ? 'peer' : (agent.runtime ?? 'claude');
  const cwd = agent.cwd ?? workspace.path;
  const row = db.ensureAgentThread({
    id: `th_${session.id}_${agent.id}`,
    sessionId: session.id,
    agentId: agent.id,
    backend,
    cwd,
    modelSnapshot: agent.model,
    agentVersion: agent.version,
    now: Date.now(),
  });
  return toThread(row);
}

/**
 * Point a session's single-agent record at an agent's runtime.
 *
 * `sessions.runtime` is read by clients that predate agents, so it mirrors the
 * leader's backend; keeping it in sync here means the old read path stays
 * correct without any client change.
 */
export function syncSessionRuntime(db: Db, sessionId: string): void {
  const leader = getLeader(db, sessionId);
  if (!leader) return;
  const backend = leader.kind === 'builtin' ? 'builtin' : leader.kind === 'peer' ? 'peer' : leader.runtime;
  if (backend) db.setSessionRuntime(sessionId, backend);
}

function normalizeName(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeSummary(raw: string | undefined): string {
  const text = (raw ?? '').trim();
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  throw new AgentValidationError(
    'summary_too_long',
    `summary must be at most ${MAX_SUMMARY_CHARS} characters`,
  );
}

function normalizeInstructions(raw: string | undefined): string {
  const text = raw ?? '';
  if (text.length <= MAX_INSTRUCTIONS_CHARS) return text;
  throw new AgentValidationError(
    'instructions_too_long',
    `instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters`,
  );
}

function normalizeCeiling(
  value: ProductPermissionMode | undefined,
  kind: Agent['kind'],
): ProductPermissionMode {
  // A peer agent runs elsewhere; its ceiling is the contract's, not ours.
  if (kind === 'peer') return 'ask';
  return value ?? 'ask';
}

/**
 * Validate and normalize the agent's directories.
 *
 * `cwd === null` means "the workspace root", which is what the run uses at
 * execution time. `extraDirs` are stored absolute and must also be inside.
 */
function normalizePaths(
  workspace: WorkspaceRow,
  cwd: string | null | undefined,
  extraDirs: string[] | null | undefined,
): { cwd: string | null; extraDirs: string[] } {
  let resolvedCwd: string | null = null;
  if (cwd) {
    const absolute = path.resolve(workspace.path, cwd);
    if (!workspaceContains(workspace.path, absolute)) {
      throw new AgentValidationError('cwd_outside_workspace', 'cwd must stay inside the workspace');
    }
    resolvedCwd = absolute === workspace.path ? null : absolute;
  }

  const dirs: string[] = [];
  for (const entry of extraDirs ?? []) {
    const absolute = path.resolve(workspace.path, entry);
    if (!workspaceContains(workspace.path, absolute)) {
      throw new AgentValidationError(
        'extra_dir_outside_workspace',
        `extra dir must stay inside the workspace: ${entry}`,
      );
    }
    if (!dirs.includes(absolute) && absolute !== (resolvedCwd ?? workspace.path)) dirs.push(absolute);
  }
  return { cwd: resolvedCwd, extraDirs: dirs };
}

function normalizeWiring(
  kind: Agent['kind'],
  runtime: string | null,
  peerId: string | null,
  remoteAgentId: string | null,
): { runtime: string | null; peerId: string | null; remoteAgentId: string | null } {
  if (kind === 'runtime') {
    if (!runtime) throw new AgentValidationError('runtime_required', 'kind=runtime needs a runtime id');
    return { runtime, peerId: null, remoteAgentId: null };
  }
  if (kind === 'peer') {
    if (!peerId || !remoteAgentId) {
      throw new AgentValidationError('peer_required', 'kind=peer needs peerId and remoteAgentId');
    }
    return { runtime: null, peerId, remoteAgentId };
  }
  // builtin runs in-process; any runtime id would be a lie.
  return { runtime: null, peerId: null, remoteAgentId: null };
}

/**
 * The single-writable rule (03-room.md §5.2).
 *
 * Enforced whenever membership semantics change, not when a run starts:
 * telling someone "this room already has a writer" while they are editing is a
 * save-time answer, whereas failing a run they just triggered is a surprise.
 */
export function assertWritableSlotFree(db: Db, sessionId: string, agent: Agent): void {
  if (agent.readOnly) return;
  const members = listSessionAgents(db, sessionId).map((row) => row.agent);
  const otherWriter = members.find((member) => member.id !== agent.id && !member.readOnly);
  if (otherWriter) {
    throw new AgentValidationError(
      'writable_agent_exists',
      `this session already has a writable agent: ${otherWriter.name}`,
    );
  }
}

export { getAgent, listAgents, listThreads, toAgent, toThread };
