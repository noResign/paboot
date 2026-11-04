import { describe, expect, it } from 'vitest';
import { MemoryScopeError, resolveMemoryScope } from '../src/memory/scope';

const lookup = (sessionId: string): { workspaceId: string } | null =>
  sessionId === 'session-1' ? { workspaceId: 'workspace-1' } : null;

function codeOf(input: Parameters<typeof resolveMemoryScope>[0]): string {
  try {
    resolveMemoryScope(input, lookup);
  } catch (error) {
    if (error instanceof MemoryScopeError) return error.code;
    throw error;
  }
  return 'no-error';
}

describe('resolveMemoryScope', () => {
  it('resolves a session id to its workspace', () => {
    expect(resolveMemoryScope({ sessionId: 'session-1' }, lookup)).toEqual({
      kind: 'workspace',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    });
  });

  it('accepts the user scope and explicit workspace scope', () => {
    expect(resolveMemoryScope({ scope: 'user' }, lookup)).toEqual({
      kind: 'user',
      workspaceId: null,
      sessionId: null,
    });
    expect(resolveMemoryScope({ scope: ' workspace:workspace-1 ' }, lookup)).toEqual({
      kind: 'workspace',
      workspaceId: 'workspace-1',
      sessionId: null,
    });
  });

  it('requires exactly one of sessionId / scope', () => {
    expect(codeOf({})).toBe('scope_required');
    expect(codeOf({ sessionId: ' ', scope: '' })).toBe('scope_required');
    expect(codeOf({ sessionId: 'session-1', scope: 'user' })).toBe('ambiguous_scope');
  });

  it('rejects unknown scopes and malformed workspace scopes', () => {
    expect(codeOf({ scope: 'space:workspace-1' })).toBe('invalid_scope');
    expect(codeOf({ scope: 'workspace:' })).toBe('invalid_scope');
    expect(codeOf({ scope: 'workspace:has space' })).toBe('invalid_scope');
  });

  it('returns 404 for an unknown session and 400 for non-string params', () => {
    expect(codeOf({ sessionId: 'missing' })).toBe('session_not_found');
    try {
      resolveMemoryScope({ sessionId: 'missing' }, lookup);
    } catch (error) {
      expect((error as MemoryScopeError).status).toBe(404);
    }
    expect(codeOf({ sessionId: ['session-1'] })).toBe('invalid_scope');
  });
});
