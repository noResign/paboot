import { describe, expect, it } from 'vitest';
import { grantKeyCandidates, toGrantKey } from '../src/permissions/tool-grants';

describe('toGrantKey', () => {
  it('keeps non-MCP tool names exact', () => {
    expect(toGrantKey('Bash')).toBe('Bash');
    expect(toGrantKey('Write')).toBe('Write');
  });

  it('scopes every tool of an MCP server to one key', () => {
    expect(toGrantKey('mcp__github__create_issue')).toBe('mcp__github__*');
    expect(toGrantKey('mcp__github__list_issues')).toBe('mcp__github__*');
  });

  it('keeps different MCP servers apart', () => {
    expect(toGrantKey('mcp__github__create_issue')).not.toBe(toGrantKey('mcp__slack__send'));
    expect(toGrantKey('mcp__slack__send')).toBe('mcp__slack__*');
  });

  it('falls back to the exact name for malformed MCP names', () => {
    expect(toGrantKey('mcp__github')).toBe('mcp__github');
    expect(toGrantKey('mcp__')).toBe('mcp__');
  });

  it('keeps privileged paboot task tools exact', () => {
    expect(toGrantKey('mcp__paboot_tasks__schedule_task')).toBe('mcp__paboot_tasks__schedule_task');
    expect(grantKeyCandidates('mcp__paboot_tasks__schedule_task')).toEqual([
      'mcp__paboot_tasks__schedule_task',
    ]);
  });
});

describe('grantKeyCandidates', () => {
  it('returns only the exact name for non-MCP tools', () => {
    expect(grantKeyCandidates('Bash')).toEqual(['Bash']);
  });

  it('accepts the server-wide grant and, for legacy rows, the exact name', () => {
    expect(grantKeyCandidates('mcp__github__create_issue')).toEqual([
      'mcp__github__*',
      'mcp__github__create_issue',
    ]);
  });
});
