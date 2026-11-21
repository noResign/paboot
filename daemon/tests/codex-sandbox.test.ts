import { describe, expect, it } from 'vitest';
import { codexSandbox, codexTurnSandbox } from '../src/runtimes/codex/session';

/**
 * A read-only agent must be enforced by Codex's own sandbox, not by asking the
 * user nicely. Both the thread-open mode and the per-turn policy therefore
 * ignore the product permission mode when the agent is read-only.
 */
describe('codex read-only sandbox', () => {
  it('opens the thread read-only regardless of the product mode', () => {
    expect(codexSandbox('ask', true)).toBe('read-only');
    expect(codexSandbox('acceptEdits', true)).toBe('read-only');
    expect(codexSandbox('bypass', true)).toBe('read-only');
  });

  it('keeps the mode-derived sandbox for a writable agent', () => {
    expect(codexSandbox('ask', false)).toBe('workspace-write');
    expect(codexSandbox('acceptEdits', false)).toBe('workspace-write');
    expect(codexSandbox('bypass', false)).toBe('danger-full-access');
  });

  it('overrides the per-turn policy too, so a bypass turn cannot write', () => {
    expect(codexTurnSandbox('bypass', true, ['/ws'])).toEqual({ type: 'readOnly' });
    expect(codexTurnSandbox('bypass', false, ['/ws'])).toEqual({ type: 'dangerFullAccess' });
    expect(codexTurnSandbox('ask', false, ['/ws', '/extra'])).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/ws', '/extra'],
      networkAccess: false,
    });
  });
});
