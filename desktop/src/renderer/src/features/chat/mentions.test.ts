import { describe, expect, it } from 'vitest';
import { mentionOptions, mentionTokenAt, mentionedAgentIds } from './mentions';

const agents = [
  { id: 'a1', name: '审阅', summary: '审查改动', available: true },
  { id: 'a2', name: '性能', summary: '压测与查询', available: false },
  { id: 'a3', name: '审阅助手', summary: '长篇审查', available: true },
];

describe('composer mentions', () => {
  it('finds whole-word mentions and dedupes', () => {
    expect(mentionedAgentIds('@审阅 看看，@审阅 再看', agents)).toEqual(['a1']);
    expect(mentionedAgentIds('@审阅助手 看一下', agents)).toEqual(['a3']);
    // `@审阅` followed by more name characters is not the shorter agent.
    expect(mentionedAgentIds('@审阅助手', agents)).not.toContain('a1');
  });

  it('detects the token under the caret', () => {
    expect(mentionTokenAt('帮我看看 @审', 8)).toEqual({ start: 5, query: '审' });
    expect(mentionTokenAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionTokenAt('@审 阅', 5)).toBeNull();
    expect(mentionTokenAt('foo@bar', 7)).toBeNull();
    // Chinese prose has no space before `@`; the picker must still open.
    expect(mentionTokenAt('你好@审', 4)).toEqual({ start: 2, query: '审' });
  });

  it('filters by name or summary and lists available members first', () => {
    expect(mentionOptions(agents, '压测').map((agent) => agent.id)).toEqual(['a2']);
    expect(mentionOptions(agents, '').map((agent) => agent.id)).toEqual(['a1', 'a3', 'a2']);
    expect(mentionOptions(agents, '', 2)).toHaveLength(2);
  });
});
