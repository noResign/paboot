/**
 * `@` handling for the composer.
 *
 * Mentions are derived from the text at send time rather than stored as chips:
 * editing or deleting a name in the draft then does the obvious thing, and
 * there is no second source of truth to drift. The daemon re-resolves names
 * anyway — this only supplies the structured ids for clients that have them.
 */

export interface MentionAgent {
  id: string;
  name: string;
  summary?: string;
  /** Disabled/offline members are listed but cannot be picked. */
  available?: boolean;
  heavy?: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Agent ids whose `@name` appears in the text, whole-word, deduped. */
export function mentionedAgentIds(text: string, agents: readonly MentionAgent[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    const needle = `@${agent.name}`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const next = text[end];
      if (next === undefined || !WORD_CHAR.test(next)) {
        if (!seen.has(agent.id)) {
          seen.add(agent.id);
          ids.push(agent.id);
        }
        break;
      }
      from = end;
    }
  }
  return ids;
}

/**
 * The `@token` under the caret, if any.
 *
 * Only whitespace terminates the query: names may contain CJK characters,
 * digits and dots, and stopping at the first non-letter would make `@审阅`
 * impossible to type.
 */
export function mentionTokenAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /\s/.test(query)) return null;
  // `foo@bar` is an email, not a mention. Only ASCII word characters and dots
  // count as an email local part — Chinese prose is usually typed without a
  // space before `@`, and blocking that made the picker feel broken.
  if (at > 0 && /[A-Za-z0-9_.]/.test(before[at - 1]!)) return null;
  return { start: at, query };
}

/** Candidates for the popover, available members first. */
export function mentionOptions(
  agents: readonly MentionAgent[],
  query: string,
  limit = 6,
): MentionAgent[] {
  const needle = query.trim().toLowerCase();
  return agents
    .filter((agent) => {
      if (!needle) return true;
      return (
        agent.name.toLowerCase().includes(needle) ||
        (agent.summary ?? '').toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      const avail = Number(b.available ?? true) - Number(a.available ?? true);
      return avail !== 0 ? avail : a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}
