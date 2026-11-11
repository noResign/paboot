import type { AppContext } from '../app/context.js';
import { resolveSessionEndsScope } from '../capabilities/scope.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import type { ContextSection } from '../context/types.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';

const MAX_INDEX_ENDS = 8;
const SUMMARY_LIMIT = 80;

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Compact end context: the primary end's user summary/notes plus a capped
 * index of the other ends. Domain conventions and end knowledge stay as
 * knowledge pointers (see knowledge-context).
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

  const sections: ContextSection[] = [];
  const primaryText = [
    `## End: ${primary.name}（${primary.kind}）`,
    primary.summary.trim(),
    primary.notes.trim(),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  if (primary.summary.trim() || primary.notes.trim()) {
    sections.push({
      kind: 'end',
      scope: 'end',
      priority: 2,
      source: 'end:primary',
      content: primaryText,
    });
  }

  const others = ends.filter((end) => end.id !== primary.id);
  const shown = others.slice(0, MAX_INDEX_ENDS - 1);
  const lines = [`## Ends`, `- 主端：${primary.name}（${primary.kind}）`];
  for (const end of shown) {
    const summary = end.summary.trim() ? ` — ${truncate(end.summary, SUMMARY_LIMIT)}` : '';
    lines.push(`- ${end.name}（${end.kind}）${summary}`);
  }
  if (others.length > shown.length) {
    lines.push(`- 还有 ${others.length - shown.length} 个端，用 end_list 查询`);
  }
  sections.push({
    kind: 'end',
    scope: 'end',
    priority: 1,
    source: 'end:index',
    content: lines.join('\n'),
  });

  return renderContextPrelude(sections, session.runtime, 1200);
}
