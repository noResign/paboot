import { describe, expect, it } from 'vitest';
import { claudePermissionHookMatcher } from '../src/permissions/hook-matcher';

function matcher(mode: 'ask' | 'acceptEdits'): RegExp {
  return new RegExp(`^(?:${claudePermissionHookMatcher(mode)})$`);
}

describe('claudePermissionHookMatcher', () => {
  it('gates write/bash/web/mcp tools in ask mode', () => {
    const re = matcher('ask');
    for (const name of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'WebFetch']) {
      expect(re.test(name)).toBe(true);
    }
    expect(re.test('Read')).toBe(false);
    expect(re.test('mcp__paboot_tasks__schedule_task')).toBe(true);
  });

  it('gates only bash/web/remaining mcp in acceptEdits mode', () => {
    const re = matcher('acceptEdits');
    expect(re.test('Bash')).toBe(true);
    expect(re.test('Write')).toBe(false);
    expect(re.test('mcp__paboot_tasks__schedule_task')).toBe(true);
  });

  it('excludes the self-gating memory server', () => {
    for (const mode of ['ask', 'acceptEdits'] as const) {
      const re = matcher(mode);
      expect(re.test('mcp__paboot_memory__forget')).toBe(false);
      expect(re.test('mcp__paboot_memory__search')).toBe(false);
    }
  });
});
