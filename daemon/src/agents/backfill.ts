import type { AgentRow, Db } from '../db/db.js';
import { MULTI_AGENT_BACKFILL_KEY, implicitAgentId } from '../db/db.js';

/**
 * P0 shadow backfill for the multi-agent model.
 *
 * Everything here is additive: it fills `agents` / `session_agents` /
 * `agent_threads` so P1 has real data to read, but nothing in the request path
 * consults those tables yet. A failure is therefore logged and swallowed — a
 * bug here must never stop the daemon from serving users.
 *
 * The tables are additive: an agent per (workspace, runtime), a leader row and
 * a thread per session. Nothing here is read by the request path yet, so a
 * failure must degrade to "shadow tables are incomplete", never to a broken
 * request.
 */

export interface BackfillResult {
  /** Workspaces that received (or already had) at least one implicit agent. */
  implicitAgents: number;
  /** Sessions that gained a leader row on this run. */
  leadersAdded: number;
  /** Sessions that gained a thread row on this run. */
  threadsAdded: number;
  /** False when a previous run already completed; the work is skipped then. */
  ran: boolean;
}

export interface BackfillLogger {
  warn(message: string, error?: unknown): void;
}

/**
 * Create the implicit agent for every (workspace, runtime) pair that live
 * sessions actually use, plus the workspace's configured default runtime so a
 * workspace with no sessions yet still has an agent to hang future sessions on.
 */
function seedImplicitAgents(db: Db): number {
  let created = 0;
  const seen = new Map<string, Set<string>>();

  const pair = (workspaceId: string, runtime: string): void => {
    const runtimes = seen.get(workspaceId) ?? new Set<string>();
    seen.set(workspaceId, runtimes);
    if (runtimes.has(runtime)) return;
    runtimes.add(runtime);
    const existed = db.getAgent(implicitAgentId(workspaceId, runtime));
    db.ensureImplicitAgent(workspaceId, runtime);
    if (!existed) created += 1;
  };

  // 1. Runtimes that real sessions use — these are the ones that must be
  //    backfilled, so they are the source of truth.
  for (const row of db.listSessionRuntimePairs()) {
    pair(row.workspace_id, row.runtime);
  }
  // 2. Workspaces with a configured default but no sessions yet.
  for (const workspace of db.listWorkspaceDefaultRuntimes()) {
    if (seen.has(workspace.id)) continue;
    pair(workspace.id, workspace.default_runtime ?? DEFAULT_IMPLICIT_RUNTIME);
  }

  // 3. Point `default_agent_id` at the first implicit agent of the workspace,
  //    preferring the configured default runtime. Read path does not use it yet;
  //    P1 will, as the middle step of the resolution fallback.
  for (const workspace of db.listWorkspaceDefaultRuntimes()) {
    if (db.getWorkspaceDefaultAgentId(workspace.id)) continue;
    const agents = db.listAgents(workspace.id).filter((agent) => agent.is_implicit === 1);
    const preferred =
      agents.find((agent) => agent.runtime === workspace.default_runtime) ?? agents[0];
    if (preferred) db.setWorkspaceDefaultAgent(workspace.id, preferred.id);
  }
  return created;
}

/**
 * The runtime an implicit agent falls back to when a workspace has neither
 * sessions nor a configured default. `builtin` is registered unconditionally
 * (no CLI detection needed), so it is the one value that is always valid.
 */
export const DEFAULT_IMPLICIT_RUNTIME = 'builtin';

export function backfillMultiAgent(db: Db, log: BackfillLogger): BackfillResult {
  const result: BackfillResult = { implicitAgents: 0, leadersAdded: 0, threadsAdded: 0, ran: false };
  if (db.getSetting(MULTI_AGENT_BACKFILL_KEY)) return result;
  result.ran = true;

  // Each step is independent: a failure in one is logged and the marker is not
  // written, so the next start retries from the top. Every statement is
  // idempotent, so partial progress is safe.
  try {
    result.implicitAgents = seedImplicitAgents(db);
  } catch (error) {
    log.warn('multi-agent backfill: seeding implicit agents failed', error);
    return result;
  }
  try {
    result.leadersAdded = db.backfillSessionLeaders();
  } catch (error) {
    log.warn('multi-agent backfill: session leaders failed', error);
    return result;
  }
  try {
    result.threadsAdded = db.backfillAgentThreads();
  } catch (error) {
    log.warn('multi-agent backfill: agent threads failed', error);
    return result;
  }

  db.setSetting(MULTI_AGENT_BACKFILL_KEY, '1');
  return result;
}

/**
 * Resolution order for "which agent owns this session".
 *
 * P0 exposes it so the dual-write can attribute runs, but `/api/chat` keeps
 * using `sessions.runtime` until P1 flips the read path. Step 4 never throws:
 * an unknown session must degrade to a synthesized agent rather than fail a
 * user's message.
 */
export interface ResolvedAgent {
  id: string;
  workspaceId: string;
  runtime: string;
  /** Which fallback step produced this answer; useful in logs and tests. */
  source: 'leader' | 'workspace_default' | 'implicit' | 'synthesized';
}

export function resolveAgentForSession(db: Db, sessionId: string): ResolvedAgent | null {
  const session = db.getSession(sessionId);
  if (!session) return null;
  const workspaceId = session.workspace_id ?? null;

  const leader = db.getSessionLeader(sessionId);
  if (leader) {
    const agent = db.getAgent(leader.agent_id);
    if (agent) {
      return { id: agent.id, workspaceId: agent.workspace_id, runtime: agent.runtime ?? session.runtime, source: 'leader' };
    }
  }

  if (workspaceId) {
    const defaultAgentId = db.getWorkspaceDefaultAgentId(workspaceId);
    if (defaultAgentId) {
      const agent = db.getAgent(defaultAgentId);
      if (agent) {
        return {
          id: agent.id,
          workspaceId: agent.workspace_id,
          runtime: agent.runtime ?? session.runtime,
          source: 'workspace_default',
        };
      }
    }
    const implicit = db.listAgents(workspaceId).filter((agent: AgentRow) => agent.is_implicit === 1);
    const matching = implicit.find((agent) => agent.runtime === session.runtime) ?? implicit[0];
    if (matching) {
      return { id: matching.id, workspaceId, runtime: matching.runtime ?? session.runtime, source: 'implicit' };
    }
  }

  // Last resort: a stable synthetic id derived from the runtime, never written.
  return {
    id: `synthetic:${session.runtime}`,
    workspaceId: workspaceId ?? '',
    runtime: session.runtime,
    source: 'synthesized',
  };
}
