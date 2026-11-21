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

/**
 * Second-stage backfill, gated separately from the first so databases that
 * already ran it still pick this up.
 *
 * It rewrites `native_threads.agent_id` from the pre-agent constant to the
 * session's leader. This must run in the same release as the driver change that
 * starts passing the real agent id — doing it earlier would strand existing
 * conversations (the driver would look up `builtin` and find nothing), and later
 * would mean every old builtin session briefly looks empty.
 */
export const NATIVE_THREAD_AGENTS_KEY = 'multi_agent_native_thread_agents_v1';

/**
 * Attribute pre-agent runs to their session's leader.
 *
 * Those runs happened before a run could name an agent, but a single-agent
 * session's leader is exactly who ran them. Without this, every historical
 * answer in a room falls back to "unknown speaker" even though the room knows
 * who the only member was.
 */
export const RUN_ATTRIBUTION_KEY = 'multi_agent_run_attribution_v1';

export function backfillRunAttribution(db: Db, log: BackfillLogger): number {
  if (db.getSetting(RUN_ATTRIBUTION_KEY)) return 0;
  try {
    const updated = db.backfillRunAttribution();
    db.setSetting(RUN_ATTRIBUTION_KEY, '1');
    return updated;
  } catch (error) {
    log.warn('multi-agent backfill: run attribution failed', error);
    return 0;
  }
}

export function backfillNativeThreadAgents(db: Db, log: BackfillLogger): number {
  if (db.getSetting(NATIVE_THREAD_AGENTS_KEY)) return 0;
  try {
    const moved = db.backfillNativeThreadAgents();
    db.setSetting(NATIVE_THREAD_AGENTS_KEY, '1');
    return moved;
  } catch (error) {
    // A failure leaves the marker unset so the next boot retries; the driver
    // then simply opens a fresh transcript rather than failing the request.
    log.warn('multi-agent backfill: native thread agents failed', error);
    return 0;
  }
}

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
