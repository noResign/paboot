import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import { buildLifeBrief } from '../memory/brief.js';
import { log } from '../platform/log.js';

export interface RunMemoryContext extends ContextPrelude {
  /** Claims that survived budget trimming. */
  claims: number;
  truncated: boolean;
}

/**
 * Build the life memory brief for external runtimes. Builtin is excluded:
 * its driver consumes the same brief through a runtime-context source so the
 * block is assembled with the rest of the agent context.
 *
 * `off` and `no_injection` both suppress injection; `no_injection` still
 * captures. Commands and the scheduled-task authoring chat never inject.
 */
export function memoryContext(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): RunMemoryContext | null {
  if (!ctx.memory) return null;
  if (workspace.family !== 'life') return null;
  if (session.runtime === 'command' || session.runtime === 'builtin') return null;
  if (session.purpose === 'task_config') return null;
  if (session.memory_mode !== 'normal') return null;

  try {
    const brief = buildLifeBrief(ctx.memory, `workspace:${workspace.id}`);
    if (!brief) return null;
    const prelude = renderContextPrelude(
      [
        {
          kind: 'memory',
          scope: 'workspace',
          priority: 0,
          content: brief.markdown,
          source: 'memory:brief',
        },
      ],
      session.runtime,
    );
    if (!prelude) return null;
    log.info(
      `memory brief: ${brief.usedClaimIds.length} claim(s), ${brief.charCount} chars` +
        `${brief.truncated ? ', truncated' : ''}`,
    );
    return { ...prelude, claims: brief.usedClaimIds.length, truncated: brief.truncated };
  } catch (err) {
    // Injection is best-effort; a broken memory.db must not block the run.
    log.warn(`memory context failed for workspace ${workspace.id}: ${String(err)}`);
    return null;
  }
}
