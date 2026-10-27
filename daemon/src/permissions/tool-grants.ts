/**
 * Tool-grant key mapping.
 *
 * A grant is normally scoped to one exact tool name. MCP tools are the
 * exception: they are named `mcp__<server>__<tool>` and a single server exposes
 * dozens of them, so "allow all" is scoped to the whole server
 * (`mcp__<server>__*`) instead of forcing one approval per tool.
 */

const MCP_PREFIX = 'mcp__';

/**
 * Servers whose tools must be granted one by one. `paboot_tasks` is
 * privileged (it can create recurring unattended runs), so "allow all" must
 * not leak to tools added to the server later.
 */
const EXACT_GRANT_SERVERS = new Set(['paboot_tasks']);

function mcpServer(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf('__');
  return separator > 0 ? rest.slice(0, separator) : undefined;
}

/** The key stored in `session_permission_grants` when the user allows all. */
export function toGrantKey(toolName: string): string {
  const server = mcpServer(toolName);
  if (server === undefined || EXACT_GRANT_SERVERS.has(server)) return toolName;
  return `${MCP_PREFIX}${server}__*`;
}

/** Grant keys that authorize `toolName`, in lookup order. */
export function grantKeyCandidates(toolName: string): string[] {
  const server = mcpServer(toolName);
  if (server === undefined || EXACT_GRANT_SERVERS.has(server)) return [toolName];
  return [`${MCP_PREFIX}${server}__*`, toolName];
}
