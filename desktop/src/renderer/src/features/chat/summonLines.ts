/** Remove a markdown prefix that commonly precedes a mention. */
function stripPrefix(line: string): string {
  return line
    .trimStart()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^(?:\*\*|__|\*|_)(?=@)/, '');
}

function startsWithMention(line: string, names: readonly string[]): boolean {
  const stripped = stripPrefix(line).replace(/`[^`\n]*`/g, '');
  if (!stripped.startsWith('@')) return false;
  return names.some((name) => {
    const needle = `@${name}`;
    if (!stripped.startsWith(needle)) return false;
    const next = stripped[needle.length];
    return next === undefined || !/[\p{L}\p{N}_]/u.test(next);
  });
}

/**
 * Split a leader answer into its normal body and line-start summon messages.
 *
 * The daemon only treats a line-start `@member` as a summon. The UI mirrors
 * that rule so prose/code/blockquote mentions stay inside the answer instead of
 * becoming fake handoff bubbles.
 */
export function splitSummonLines(
  text: string,
  memberNames: readonly string[],
): { body: string; summons: string[] } {
  if (memberNames.length === 0) return { body: text, summons: [] };
  const body: string[] = [];
  const summons: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      body.push(line);
      continue;
    }
    if (inFence || /^\s*>/.test(line)) {
      body.push(line);
      continue;
    }
    if (startsWithMention(line, memberNames)) summons.push(line.trim());
    else body.push(line);
  }
  return { body: body.join('\n').trim(), summons };
}
