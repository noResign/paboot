import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import { buildKnowledgeSections } from '../knowledge/index.js';
import { log } from '../platform/log.js';

export interface KnowledgePrelude extends ContextPrelude {
  /** How many confirmed documents contributed pointers. */
  documents: number;
}

/**
 * First-turn knowledge injection (K0).
 *
 * Only a session that has not started its provider conversation yet gets the
 * block: once `native_session_id` exists the runtime resumes its own transcript,
 * and re-injecting would change the prompt prefix and break its cache. Command
 * sessions are excluded too — their "prompt" is a shell command. Life K0 is
 * deferred by plan, so life workspaces stay untouched.
 */
export function knowledgePrelude(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): KnowledgePrelude | null {
  if (session.runtime === 'command') return null;
  // builtin replays native_messages and never gets a provider-native id, so
  // "no native id" would be true on every run. P3 injects knowledge through
  // the ContextAssembler instead; keep the prelude for external runtimes.
  if (session.runtime === 'builtin') return null;
  if (session.native_session_id) return null;
  if (workspace.family !== 'dev') return null;
  // `purpose=task_config` stays eligible on purpose: the AI authoring chat can
  // use project knowledge too (decision 2026-11-05).
  // Partial test harnesses omit the store; production always wires it.
  if (!ctx.knowledge) return null;

  try {
    const documents = ctx.knowledge.confirmed(workspace.id, session.end_id);
    if (documents.length === 0) return null;

    const prelude = renderContextPrelude(
      buildKnowledgeSections(ctx.knowledge.root(workspace.id), documents),
      session.runtime,
    );
    if (!prelude) return null;
    return { ...prelude, documents: documents.length };
  } catch (err) {
    // Injection is an optimisation: a broken knowledge store must never stop
    // the user's run. Surface it in the log and continue without the block.
    log.warn(`knowledge prelude failed for workspace ${workspace.id}: ${String(err)}`);
    return null;
  }
}
