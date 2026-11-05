import { createHash } from 'node:crypto';
import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import { buildKnowledgeSections } from '../knowledge/index.js';
import { log } from '../platform/log.js';

export interface RunKnowledgeContext extends ContextPrelude {
  /** How many confirmed documents contributed pointers. */
  documents: number;
  /** Stable hash of the rendered block, for cache diagnostics. */
  indexVersion: string;
}

/**
 * Build the workspace-knowledge block for a run. This is intentionally
 * independent of `native_session_id`: runtimes with a native system prompt
 * (Claude `--append-system-prompt`) receive it on every run so an edited doc is
 * reflected on the next turn, while the block stays byte-identical when nothing
 * changed (prompt-cache friendly).
 *
 * Command sessions are excluded — their "prompt" is a shell command. Life and
 * builtin are deferred; builtin will use the ContextAssembler in P3.
 */
export function knowledgeContext(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): RunKnowledgeContext | null {
  if (session.runtime === 'command' || session.runtime === 'builtin') return null;
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
    return {
      ...prelude,
      documents: documents.length,
      indexVersion: createHash('sha256').update(prelude.prefix, 'utf8').digest('hex').slice(0, 16),
    };
  } catch (err) {
    // Injection is an optimisation: a broken knowledge store must never stop
    // the user's run. Surface it in the log and continue without the block.
    log.warn(`knowledge context failed for workspace ${workspace.id}: ${String(err)}`);
    return null;
  }
}

/**
 * K0 fallback for runtimes without a native system prompt: prepend the block to
 * the first user message only. Resuming must not re-inject — it would change
 * the prompt prefix and break the provider's cache.
 */
export function knowledgePrelude(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): RunKnowledgeContext | null {
  if (session.native_session_id) return null;
  return knowledgeContext(ctx, session, workspace);
}
