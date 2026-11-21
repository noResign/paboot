import { describe, expect, it } from 'vitest';
import { mentionsAll, parseMentionNames, routeMentions } from '../src/agents/mentions';
import type { Agent } from '../src/agents/types';

/**
 * `@` routing is the one place where a wrong answer is immediately visible: the
 * user addressed someone and a different agent answered. These cases therefore
 * assert the *dropped* path as carefully as the happy one.
 */

function agent(id: string, name: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    workspaceId: 'w',
    name,
    summary: '',
    avatar: null,
    kind: 'builtin',
    runtime: null,
    peerId: null,
    remoteAgentId: null,
    model: null,
    modelParameters: null,
    instructions: '',
    cwd: null,
    extraDirs: [],
    readOnly: false,
    permissionCeiling: 'ask',
    toolsAllow: null,
    toolsDeny: null,
    skills: null,
    budget: null,
    heavy: false,
    enabled: true,
    version: 1,
    isImplicit: false,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const leader = agent('a1', '默认');
const review = agent('a2', '审阅', { readOnly: true });
const writer = agent('a3', '实现');
const off = agent('a4', '停用的', { enabled: false });
const members = [leader, review, writer, off];

describe('routeMentions', () => {
  it('routes to the leader when the user addressed nobody', () => {
    const result = routeMentions({ mentionIds: [], all: false, leader, members });
    expect(result.targets.map((t) => t.agent.id)).toEqual(['a1']);
    expect(result.targets[0]!.source).toBe('leader_default');
  });

  it('routes to exactly the mentioned agents, in the order written', () => {
    const result = routeMentions({ mentionIds: ['a3', 'a2'], all: false, leader, members });
    expect(result.targets.map((t) => t.agent.id)).toEqual(['a3', 'a2']);
    expect(result.targets.every((t) => t.source === 'mention')).toBe(true);
  });

  it('includes the leader when it is named explicitly', () => {
    const result = routeMentions({ mentionIds: ['a1', 'a3'], all: false, leader, members });
    expect(result.targets.map((t) => t.agent.id)).toEqual(['a1', 'a3']);
  });

  it('dedupes a repeated mention instead of starting two tasks', () => {
    const result = routeMentions({ mentionIds: ['a2', 'a2'], all: false, leader, members });
    expect(result.targets).toHaveLength(1);
  });

  it('drops an unknown id rather than falling back to the leader', () => {
    const result = routeMentions({ mentionIds: ['nope'], all: false, leader, members });
    // Answering anyway would look like the wrong agent ignored the question.
    expect(result.targets).toEqual([]);
    expect(result.dropped).toEqual([{ id: 'nope', reason: 'unknown' }]);
  });

  it('drops a disabled member and keeps the rest', () => {
    const result = routeMentions({ mentionIds: ['a4', 'a2'], all: false, leader, members });
    expect(result.targets.map((t) => t.agent.id)).toEqual(['a2']);
    expect(result.dropped).toEqual([{ id: 'a4', reason: 'disabled' }]);
  });

  it('@all includes every enabled member, leader first', () => {
    const result = routeMentions({ mentionIds: [], all: true, leader, members });
    expect(result.targets.map((t) => t.agent.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('@all still honours the per-turn cap', () => {
    const crowd = Array.from({ length: 12 }, (_, index) => agent(`m${index}`, `m${index}`));
    const result = routeMentions({ mentionIds: [], all: true, leader: crowd[0]!, members: crowd });
    expect(result.targets).toHaveLength(8);
  });

  it('treats an explicit mention as taking precedence over @all text', () => {
    // `@all` wins in the caller (it sets `all`); a structured mention list must
    // still be usable on its own.
    const result = routeMentions({ mentionIds: ['a2'], all: false, leader, members });
    expect(result.targets.map((t) => t.agent.id)).toEqual(['a2']);
  });
});

describe('parseMentionNames', () => {
  it('finds names anywhere in the text', () => {
    expect(parseMentionNames('@审阅 看一下，然后 @实现 改掉', members)).toEqual(['审阅', '实现']);
  });

  it('prefers the longest name so a prefix does not win', () => {
    const long = agent('a9', '审阅助手');
    const roster = [agent('a2', '审阅'), long];
    expect(parseMentionNames('@审阅助手 你来', roster)).toEqual(['审阅助手']);
  });

  it('ignores a name that is only the prefix of a longer word', () => {
    const roster = [agent('a2', '审阅')];
    expect(parseMentionNames('@审阅助手 你来', roster)).toEqual([]);
  });

  it('returns nothing for text without mentions', () => {
    expect(parseMentionNames('帮我看看这个', members)).toEqual([]);
  });

  it('does not double-count a name mentioned twice', () => {
    expect(parseMentionNames('@审阅 看这个，@审阅 再看这个', members)).toEqual(['审阅', '审阅']);
  });
});

describe('mentionsAll', () => {
  it('recognises both spellings', () => {
    expect(mentionsAll('@all 看一下')).toBe(true);
    expect(mentionsAll('@全体成员 看一下')).toBe(true);
    expect(mentionsAll('@alice 看一下')).toBe(false);
  });
});
