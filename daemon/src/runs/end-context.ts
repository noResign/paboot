import type { AppContext } from '../app/context.js';
import { END_CONTEXT_BUDGET, renderEndContext } from '../ends/render.js';
import { resolveSessionEndsScope } from '../ends/scope.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import type { ContextSection } from '../context/types.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';

/**
 * Compact end context: the primary end's description/notes plus a capped index
 * of the other ends. Domain conventions and end knowledge stay as knowledge
 * pointers (see knowledge-context).
 *
 * Builtin does not go through here — it has no first-message prelude and renders
 * the same content as one of its own runtime-context sources instead
 * (`runtimes/builtin/context/ends.ts`), sharing `renderEndContext`.
 */
export function endsContext(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): ContextPrelude | null {
  if (session.runtime === 'command' || session.runtime === 'builtin') return null;
  if (workspace.family !== 'dev') return null;
  const { ends, primary } = resolveSessionEndsScope(ctx.db, session);
  if (ends.length === 0 || !primary) return null;

  const rendered = renderEndContext(ends, primary);
  const sections: ContextSection[] = [];
  if (rendered.primary) {
    sections.push({
      kind: 'end',
      scope: 'end',
      priority: 2,
      source: 'end:primary',
      content: rendered.primary,
    });
  }
  sections.push({
    kind: 'end',
    scope: 'end',
    priority: 1,
    source: 'end:index',
    content: rendered.index,
  });

  return renderContextPrelude(sections, session.runtime, END_CONTEXT_BUDGET);
}
