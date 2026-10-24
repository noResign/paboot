import { describe, expect, it } from 'vitest';
import { describeToolGroup, segmentBlocks, toolGroupStatus, toolSummary } from './segments';
import type { ContentBlock } from '../../store/chat/types';

type ToolBlock = Extract<ContentBlock, { kind: 'tool' }>;

const text = (t: string): ContentBlock => ({ kind: 'text', text: t });
const tool = (id: string, name = 'Bash'): ToolBlock => ({
  kind: 'tool',
  id,
  name,
  input: {},
  result: null,
  isError: false,
  interrupted: false,
  running: false,
});

describe('segmentBlocks', () => {
  it('groups consecutive tool calls and breaks on prose', () => {
    const segments = segmentBlocks([tool('a'), tool('b'), text('done'), tool('c')]);
    expect(segments.map((s) => s.kind)).toEqual(['tools', 'text', 'tools']);
    expect(segments[0]).toMatchObject({ kind: 'tools' });
    expect((segments[0] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  it('breaks a tool group on thinking too', () => {
    const segments = segmentBlocks([tool('a'), { kind: 'thinking', active: false }, tool('b')]);
    expect(segments.map((s) => s.kind)).toEqual(['tools', 'thinking', 'tools']);
  });

  it('returns nothing for an empty message', () => {
    expect(segmentBlocks([])).toEqual([]);
  });
});

describe('tool group summary', () => {
  it('lists distinct names and caps the count', () => {
    expect(describeToolGroup([tool('1', 'Write'), tool('2', 'Bash'), tool('3', 'Write')])).toBe(
      '3 个工具调用 · Write, Bash',
    );
  });

  it('counts running, failed and interrupted tools', () => {
    const status = toolGroupStatus([
      { ...tool('1'), running: true },
      { ...tool('2'), isError: true },
      { ...tool('3'), interrupted: true },
    ]);
    expect(status).toEqual({ running: 1, failed: 1, interrupted: 1 });
  });
});

describe('toolSummary', () => {
  it('prefers the field the built-ins actually carry', () => {
    expect(toolSummary({ command: 'pnpm test --filter auth' })).toBe('pnpm test --filter auth');
    expect(toolSummary({ file_path: 'src/auth/session.ts' })).toBe('src/auth/session.ts');
    expect(toolSummary({ pattern: 'needsRefresh|expiresAt', path: 'src/auth' })).toBe('needsRefresh|expiresAt');
  });

  it('flattens whitespace so a multi-line command stays one line', () => {
    expect(toolSummary({ command: 'cat a\n  && echo b' })).toBe('cat a && echo b');
  });

  it('truncates rather than letting a long command push the row out', () => {
    const long = 'x'.repeat(200);
    const result = toolSummary({ command: long });
    expect(result).toHaveLength(81);
    expect(result?.endsWith('…')).toBe(true);
  });

  it('returns null when there is nothing worth showing', () => {
    expect(toolSummary({})).toBeNull();
    expect(toolSummary({ command: '   ' })).toBeNull();
    expect(toolSummary(null)).toBeNull();
    expect(toolSummary('not an object')).toBeNull();
  });
});
