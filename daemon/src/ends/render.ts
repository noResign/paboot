import type { EndRow } from '../db/db.js';

/**
 * How an end reaches the model. One renderer for both channels — the
 * first-message prelude used by Claude / Codex / DeepSeek (`runs/end-context`)
 * and the builtin runtime's own runtime-context snapshot — so an end's
 * description cannot mean two different things depending on the runtime.
 *
 * `kind` is deliberately absent: it is an internal tag (it only picks which
 * conventions get seeded) and no longer appears in the UI, so mentioning it to
 * the model would describe a concept the user cannot see or change.
 */

/** Index cap, primary excluded (the section's own line already names it). */
export const END_INDEX_MAX = 8;
export const END_SUMMARY_LIMIT = 80;
export const END_NOTES_LIMIT = 120;

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export interface RenderedEndContext {
  /** Primary end's own section; null when it has no description and no notes. */
  primary: string | null;
  /** One-line index: the primary plus up to `END_INDEX_MAX - 1` other ends. */
  index: string;
}

/**
 * Primary gets its description and notes in full; every other end gets a single
 * line with a truncated description and notes. Notes are included for the others
 * too — they are the author's own warnings ("don't touch versionCode"), which is
 * exactly what a run touching that end needs.
 */
export function renderEndContext(
  ends: readonly EndRow[],
  primary: EndRow,
): RenderedEndContext {
  const primaryText = [`## End: ${primary.name}`, primary.summary.trim(), primary.notes.trim()]
    .filter((part) => part !== '')
    .join('\n\n');

  const others = ends.filter((end) => end.id !== primary.id);
  const shown = others.slice(0, END_INDEX_MAX - 1);
  const lines = ['## Ends', `- 主端：${primary.name}${detailOf(primary)}`];
  for (const end of shown) {
    lines.push(`- ${end.name}${detailOf(end)}`);
  }
  if (others.length > shown.length) {
    lines.push(`- 还有 ${others.length - shown.length} 个端`);
  }

  return {
    // A bare name adds nothing the index line does not already say.
    primary: primary.summary.trim() || primary.notes.trim() ? primaryText : null,
    index: lines.join('\n'),
  };
}

/** ` — 描述 · 注意：注意事项`, each part omitted when empty. */
function detailOf(end: EndRow): string {
  const summary = truncate(end.summary ?? '', END_SUMMARY_LIMIT);
  const notes = truncate(end.notes ?? '', END_NOTES_LIMIT);
  return [summary ? ` — ${summary}` : '', notes ? ` · 注意：${notes}` : ''].join('');
}

/**
 * Budget for the whole end block. Worst case is the primary's full text plus
 * `END_INDEX_MAX - 1` index lines of name + 80 + 120 characters; staying under
 * that would make the assembler drop the whole index section (it only drops
 * sections, never trims them), so the cap has to leave room for it.
 */
export const END_CONTEXT_BUDGET = 2000;
