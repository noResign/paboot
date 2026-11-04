/**
 * Memory read-scope parsing (P0.5).
 *
 * Memory routes must be called with either a session id or an explicit scope;
 * never with an ambiguous/missing scope. This module is pure so the same rules
 * are shared by every future memory endpoint (P4) and can be tested before the
 * routes exist.
 *
 * Scope is a *retrieval* boundary, not an OS sandbox: Bash can still read the
 * data dir. See docs/local/paboot_memory/design.md.
 */

export type MemoryScopeKind = 'user' | 'workspace';

export interface ResolvedMemoryScope {
  kind: MemoryScopeKind;
  /** Set for workspace/session scopes; null for the user scope. */
  workspaceId: string | null;
  /** Set when the caller passed a session id. */
  sessionId: string | null;
}

export type MemoryScopeErrorCode =
  | 'scope_required'
  | 'ambiguous_scope'
  | 'invalid_scope'
  | 'session_not_found';

export class MemoryScopeError extends Error {
  readonly code: MemoryScopeErrorCode;
  readonly status: 400 | 404;

  constructor(code: MemoryScopeErrorCode, message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = 'MemoryScopeError';
    this.code = code;
    this.status = status;
  }
}

export interface MemoryScopeInput {
  sessionId?: unknown;
  scope?: unknown;
}

/** Resolve a session id to its workspace; return null when it does not exist. */
export type SessionScopeLookup = (sessionId: string) => { workspaceId: string } | null;

export function resolveMemoryScope(
  input: MemoryScopeInput,
  lookup: SessionScopeLookup,
): ResolvedMemoryScope {
  const sessionId = normalize(input.sessionId, 'sessionId');
  const scopeRaw = normalize(input.scope, 'scope');

  if (sessionId && scopeRaw) {
    throw new MemoryScopeError('ambiguous_scope', 'pass either sessionId or scope, not both');
  }
  if (!sessionId && !scopeRaw) {
    throw new MemoryScopeError('scope_required', 'sessionId or scope is required');
  }

  if (sessionId) {
    const session = lookup(sessionId);
    if (!session) {
      throw new MemoryScopeError('session_not_found', 'session not found', 404);
    }
    return { kind: 'workspace', workspaceId: session.workspaceId, sessionId };
  }

  if (scopeRaw === 'user') {
    return { kind: 'user', workspaceId: null, sessionId: null };
  }
  if (scopeRaw.startsWith('workspace:')) {
    const workspaceId = scopeRaw.slice('workspace:'.length).trim();
    if (!workspaceId || /\s/.test(workspaceId)) {
      throw new MemoryScopeError('invalid_scope', 'invalid workspace scope');
    }
    return { kind: 'workspace', workspaceId, sessionId: null };
  }
  throw new MemoryScopeError('invalid_scope', 'scope must be "user" or "workspace:<id>"');
}

function normalize(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new MemoryScopeError('invalid_scope', `${field} must be a string`);
  }
  return value.trim();
}
