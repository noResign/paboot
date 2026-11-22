import { describe, expect, it } from 'vitest';
import { agentDisplayName } from './agentLabel';

describe('agentDisplayName', () => {
  it('shows the implicit leader as 主答 instead of an internal default name', () => {
    expect(
      agentDisplayName({ id: 'implicit:w:claude', name: '默认 (claude)', role: 'leader' }),
    ).toBe('主答');
  });

  it('keeps a user-created leader name', () => {
    expect(agentDisplayName({ id: 'ag_1', name: '审阅', role: 'leader' })).toBe('审阅');
  });

  it('keeps member names regardless of whether they look like defaults', () => {
    expect(agentDisplayName({ id: 'ag_2', name: '默认助手', role: 'member' })).toBe('默认助手');
  });
});
