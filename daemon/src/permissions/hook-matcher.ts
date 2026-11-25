/**
 * PreToolUse matcher passed to Claude Code (P0.5).
 *
 * `mcp__paboot_memory__*` self-gates inside the MCP server, so routing it
 * through the hook would ask twice. `paboot_tasks` stays gated: it can create
 * unattended recurring runs.
 *
 * The negative lookahead is evaluated by Claude Code's JS regex engine.
 */
export type HookPermissionMode = 'ask' | 'acceptEdits';

export function claudePermissionHookMatcher(
  mode: HookPermissionMode,
  options: { includeReads?: boolean } = {},
): string {
  // Peer runs include reads so the daemon can reject `~/.paboot` paths; normal
  // runs keep the historical "reads are not gated" behaviour and pay no RTT.
  const reads = options.includeReads ? 'Read|Grep|Glob|' : '';
  const gated = mode === 'ask'
    ? `${reads}Bash|Write|Edit|MultiEdit|NotebookEdit|WebSearch|WebFetch`
    : `${reads}Bash|WebSearch|WebFetch`;
  return `${gated}|mcp__(?!paboot_memory__).*`;
}
