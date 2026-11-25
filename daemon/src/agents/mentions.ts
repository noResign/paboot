import type { Agent } from './types.js';

/**
 * Resolve which agents a message is addressed to.
 *
 * The rule is deliberately boring, because this is the one place where a wrong
 * answer is immediately visible to the user as "it answered when I asked
 * someone else":
 *
 *   1. explicit `@name` → exactly those members, in the order written
 *   2. `@all`          → every available member
 *   3. no mention      → the leader (the room's default speaker), exactly one
 *
 * Anything else — an unknown name, a disabled agent — is *dropped* rather than
 * escalating to the leader: silently answering when the user addressed someone
 * else is worse than not answering at all.
 *
 * `heavy` (external CLI) agents are included: `@name` is the explicit request
 * they are gated on, so honouring it is the whole point.
 */

/**
 * Remove what is being *quoted*, not said: fenced/inline code and blockquote
 * lines. A `@name` inside a quote is someone else's words (a pasted log, the
 * text this message is replying to) and must not route a task.
 */
function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

export interface MentionTarget {
  agent: Agent;
  /** Why this agent is in the list; carried into `agent_tasks.source`. */
  source: 'mention' | 'leader_default';
}

export interface RouteInput {
  /** Raw `mentions` from the request: agent ids, already resolved by the client. */
  mentionIds: readonly string[];
  /** Set when the text contained `@all`. */
  all: boolean;
  /** The session's leader, already resolved. */
  leader: Agent;
  /** Every member, leader first. */
  members: readonly Agent[];
}

export interface RouteResult {
  targets: MentionTarget[];
  /**
   * Names/ids the user addressed that are not usable, so the caller can tell
   * them why instead of silently dropping the message.
   */
  dropped: { id: string; reason: 'unknown' | 'disabled' | 'unavailable' }[];
}

export const MAX_MENTIONS = 8;

export function routeMentions(input: RouteInput): RouteResult {
  const byId = new Map(input.members.map((member) => [member.id, member]));
  const dropped: RouteResult['dropped'] = [];

  const usable = (id: string): Agent | null => {
    const agent = byId.get(id);
    if (!agent) {
      dropped.push({ id, reason: 'unknown' });
      return null;
    }
    if (!agent.enabled) {
      dropped.push({ id, reason: 'disabled' });
      return null;
    }
    // Peer agents are members like any other for an explicit `@`; only the
    // leader's automatic summon (`@all`) keeps them out (they are expensive
    // remote calls and must be addressed deliberately).
    return agent;
  };

  if (input.all) {
    // External CLIs are expensive and start a process each; `@all` is not the
    // explicit request their `heavy` flag is gated on, so they sit it out.
    const targets = input.members
      .filter((member) => member.enabled && !member.heavy && member.kind !== 'peer')
      .slice(0, MAX_MENTIONS)
      .map((agent) => ({ agent, source: 'mention' as const }));
    // The leader is a member too, so `@all` already includes it.
    return { targets: dedupe(targets), dropped };
  }

  const explicit = input.mentionIds
    .slice(0, MAX_MENTIONS)
    .map(usable)
    .filter((agent): agent is Agent => agent !== null)
    .map((agent) => ({ agent, source: 'mention' as const }));
  if (explicit.length > 0) return { targets: dedupe(explicit), dropped };

  // No explicit mention (or every one of them was unusable). Fall back to the
  // leader only when the user addressed nobody at all: a typo'd `@` must not
  // turn into "the leader answers anyway".
  if (input.mentionIds.length > 0) return { targets: [], dropped };
  return { targets: [{ agent: input.leader, source: 'leader_default' }], dropped };
}

function dedupe(targets: MentionTarget[]): MentionTarget[] {
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.agent.id)) continue;
    seen.add(target.agent.id);
    out.push(target);
  }
  return out;
}

/**
 * Parse `@name` out of a message body.
 *
 * Only used as a fallback when a client sends text without structured mentions
 * (older clients, or someone typing in a plain text field). The result is a set
 * of *names*, which the caller resolves against the roster — matching by id
 * here would need the same roster anyway.
 *
 * Longest-match wins so `@审阅助手` does not resolve to `@审阅`; an ambiguous
 * name is left unresolved (it stays plain text) rather than guessing.
 */
export function parseMentionNames(text: string, members: readonly Agent[]): string[] {
  const names = [...members].sort((a, b) => b.name.length - a.name.length).map((m) => m.name);
  const found: string[] = [];
  const consumed = new Set<number>();
  // Same rule as summons and `@all`: quoted text is not an instruction.
  const said = stripQuoted(text);

  for (const name of names) {
    const needle = `@${name}`;
    let from = 0;
    for (;;) {
      const at = said.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      // Reject `@名字` that is really a prefix of a longer word (`@审阅助手`).
      const nextChar = said[end];
      const isWholeWord = nextChar === undefined || !/[\p{L}\p{N}_]/u.test(nextChar);
      const overlaps = [...consumed].some((index) => index >= at && index < end);
      if (isWholeWord && !overlaps) {
        found.push(name);
        for (let i = at; i < end; i += 1) consumed.add(i);
      }
      from = end;
    }
  }
  return found;
}

/**
 * Agents a leader summoned in its final answer.
 *
 * Only a line that *starts* with `@name` (after optional whitespace) counts.
 * Code fences, inline code and blockquotes are removed first, because a leader
 * explaining "I could write @someone here" must not actually start that agent —
 * that exact false positive happened once and ran a full task.
 *
 * Within a qualifying line the same whole-word / longest-name rules as
 * `parseMentionNames` apply, and the order is textual so the first three are
 * the ones the reader sees first.
 */
export function findSummonMentions(text: string, members: readonly Agent[]): Agent[] {
  const stripped = stripQuoted(text);

  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const line of stripped.split('\n')) {
    const summon = stripMarkdownPrefix(line);
    if (!summon.startsWith('@')) continue;
    for (const agent of mentionsInText(summon, members)) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      out.push(agent);
    }
  }
  return out;
}

/**
 * Remove the markdown decoration a leader naturally puts before a mention:
 * headings, list markers (with optional task checkbox), and emphasis wrapping
 * the mention itself. Without this, `- @name` and `**@name**` would silently
 * never summon.
 */
function stripMarkdownPrefix(line: string): string {
  return line
    .trimStart()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^(?:\*\*|__|\*|_)(?=@)/, '');
}

/** Whole-word `@name` hits inside one line, in textual order. */
function mentionsInText(text: string, members: readonly Agent[]): Agent[] {
  const hits: { agent: Agent; at: number; end: number }[] = [];
  const consumed = new Set<number>();
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);

  for (const agent of byLength) {
    const needle = `@${agent.name}`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const nextChar = text[end];
      const isWholeWord = nextChar === undefined || !/[\p{L}\p{N}_]/u.test(nextChar);
      const overlaps = [...consumed].some((index) => index >= at && index < end);
      if (isWholeWord && !overlaps) {
        hits.push({ agent, at, end });
        for (let i = at; i < end; i += 1) consumed.add(i);
      }
      from = end;
    }
  }

  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const hit of hits) {
    if (seen.has(hit.agent.id)) continue;
    seen.add(hit.agent.id);
    out.push(hit.agent);
  }
  return out;
}

/**
 * True when the text addresses everyone.
 *
 * Code and blockquotes are stripped first: documentation/examples mentioning
 * the token must not turn into a real broadcast. Ordinary prose may still say
 * `@all` anywhere, which is the intended user-facing behaviour.
 */
export function mentionsAll(text: string): boolean {
  const stripped = stripQuoted(text);
  return /@all\b/i.test(stripped) || stripped.includes('@全体');
}
