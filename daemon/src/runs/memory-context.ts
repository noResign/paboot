import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import { buildMemoryBrief } from '../memory/brief.js';
import { resolveReadPolicy } from '../memory/read-policy.js';
import { isMemoryInjectionEnabled } from '../memory/settings.js';
import { log } from '../platform/log.js';

export interface RunMemoryContext extends ContextPrelude {
  /** Claims that survived budget trimming. */
  claims: number;
  truncated: boolean;
  /** [debug] Claim ids actually rendered into the brief. */
  usedClaimIds: string[];
}

/**
 * Build the claim/profile brief for external runtimes. Builtin is excluded: its
 * driver consumes the same brief through a runtime-context source.
 *
 * The current session's own timeline is deliberately NOT injected: the runtime
 * already holds that conversation, so a recap duplicates tokens and breaks
 * prompt caching. Cross-session context arrives through `memoryRecall` when the
 * prompt is actually related to it.
 */
export function memoryContext(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): RunMemoryContext | null {
  if (!ctx.memory) return null;
  if (session.runtime === 'command' || session.runtime === 'builtin') return null;
  if (session.purpose === 'task_config') return null;
  if (session.memory_mode !== 'normal') return null;

  try {
    const settings = ctx.db.getMemorySettings(workspace.id);
    if (!isMemoryInjectionEnabled(workspace, settings)) return null;
    const policy = resolveReadPolicy({
      workspace,
      workspaces: ctx.db.listWorkspaces(),
      getSettings: (workspaceId) => ctx.db.getMemorySettings(workspaceId),
    });
    if (policy.scopes.length === 0) return null;
    // Private claims stay out of work-session injection; life may include them.
    const brief = buildMemoryBrief(ctx.memory, policy, {
      scope: `workspace:${workspace.id}`,
      includePrivate: workspace.family === 'life',
    });
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
    return {
      ...prelude,
      claims: brief.usedClaimIds.length,
      truncated: brief.truncated,
      usedClaimIds: brief.usedClaimIds,
    };
  } catch (err) {
    // Injection is best-effort; a broken memory.db must not block the run.
    log.warn(`memory context failed for workspace ${workspace.id}: ${String(err)}`);
    return null;
  }
}
