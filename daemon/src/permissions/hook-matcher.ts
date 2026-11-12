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

export function claudePermissionHookMatcher(mode: HookPermissionMode): string {
  const gated = mode === 'ask'
    ? 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebSearch|WebFetch'
    : 'Bash|WebSearch|WebFetch';
  return `${gated}|mcp__(?!paboot_memory__).*`;
}
