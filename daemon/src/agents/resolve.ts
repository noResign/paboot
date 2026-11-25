import type { Db, WorkspaceRow } from '../db/db.js';
import { ensureThread, syncSessionRuntime } from './service.js';
import { getAgent, getLeader, toAgent } from './store.js';
import type { Agent, AgentThread } from './types.js';

/**
 * "Which agent runs this session, and in which conversation?"
 *
 * Sessions created before agents existed have no membership rows, and a client
 * may address a session whose agent was deleted. Resolution therefore never
 * throws: it degrades through three steps and finally to a synthesized agent
 * that behaves exactly like the pre-agent daemon.
 *
 * The fallback order matters:
 *   1. the session's leader — the normal case
 *   2. the workspace default agent — a session that lost its leader
 *   3. the workspace's implicit agent for the session's runtime
 *   4. synthesized from `sessions.runtime` (never written)
 */

export interface ResolvedSessionAgent {
  agent: Agent;
  thread: AgentThread;
  /** Which step produced this answer; useful in logs and tests. */
  source: 'leader' | 'workspace_default' | 'implicit' | 'synthesized';
}

export function resolveSessionAgent(
  db: Db,
  session: { id: string; runtime: string; workspace_id: string | null; cwd: string },
  workspace: WorkspaceRow | null,
): ResolvedSessionAgent | null {
  if (!workspace) return null;

  const leader = getLeader(db, session.id);
  if (leader) {
    return { agent: leader, thread: ensureThread(db, session, leader, workspace), source: 'leader' };
  }

  // No leader means no membership rows at all (the leader cannot be removed via
  // the API), so adopting one here can never exceed the room cap that
  // `addToSession` enforces — these writes deliberately skip `assertRoomHasSpace`.
  const fromDefault = defaultAgentFor(db, workspace.id);
  if (fromDefault) {
    // Adopt it as leader so the next resolution takes step 1 instead of
    // re-deriving the same fallback on every message.
    db.upsertSessionAgent({
      session_id: session.id,
      agent_id: fromDefault.id,
      role: 'leader',
      added_by: null,
      joined_at: Date.now(),
    });
    syncSessionRuntime(db, session.id);
    return {
      agent: fromDefault,
      thread: ensureThread(db, session, fromDefault, workspace),
      source: 'workspace_default',
    };
  }

  const implicit = db
    .listAgents(workspace.id)
    .map(toAgent)
    .find((agent) => agent.isImplicit && agent.runtime === session.runtime);
  if (implicit) {
    db.upsertSessionAgent({
      session_id: session.id,
      agent_id: implicit.id,
      role: 'leader',
      added_by: null,
      joined_at: Date.now(),
    });
    syncSessionRuntime(db, session.id);
    return { agent: implicit, thread: ensureThread(db, session, implicit, workspace), source: 'implicit' };
  }

  // Nothing in the workspace: behave like the pre-agent daemon. The agent is
  // synthesized in memory (not written) so an unattributable session still runs
  // on its own runtime rather than failing.
  const synthesized = synthesize(session, workspace);
  return {
    agent: synthesized,
    thread: ensureThread(db, session, synthesized, workspace),
    source: 'synthesized',
  };
}

/**
 * The workspace's configured default agent, falling back to its first implicit
 * one. Returns null only for a workspace with no agents at all.
 */
export function defaultAgentFor(db: Db, workspaceId: string): Agent | null {
  const pinned = db.getWorkspaceDefaultAgentId(workspaceId);
  if (pinned) {
    const agent = getAgent(db, pinned);
    // A peer must never become a room's default speaker by accident.
    if (agent && agent.enabled && agent.kind !== 'peer') return agent;
  }
  const implicit = db
    .listAgents(workspaceId)
    .map(toAgent)
    .find((agent) => agent.isImplicit && agent.enabled);
  return implicit ?? null;
}

/**
 * An agent shaped from the session's own runtime, for a workspace that has none.
 *
 * `kind` is `runtime` unless the session runs on the in-process backend, so the
 * run path picks the same driver the session already names.
 */
function synthesize(
  session: { id: string; runtime: string; cwd: string; workspace_id: string | null },
  workspace: WorkspaceRow,
): Agent {
  const builtin = session.runtime === 'builtin';
  return {
    id: `synth:${session.runtime}`,
    workspaceId: session.workspace_id ?? workspace.id,
    name: '默认',
    summary: '',
    avatar: null,
    kind: builtin ? 'builtin' : 'runtime',
    runtime: builtin ? null : session.runtime,
    peerId: null,
    remoteAgentId: null,
    model: null,
    modelParameters: null,
    instructions: '',
    cwd: session.cwd === workspace.path ? null : session.cwd,
    extraDirs: [],
    readOnly: false,
    permissionCeiling: 'ask',
    skills: null,
    budget: null,
    heavy: false,
    enabled: true,
    version: 1,
    isImplicit: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The backend id a run should use for this agent. */
export function backendFor(agent: Agent): string {
  if (agent.kind === 'builtin') return 'builtin';
  if (agent.kind === 'peer') return 'peer';
  return agent.runtime ?? 'claude';
}
