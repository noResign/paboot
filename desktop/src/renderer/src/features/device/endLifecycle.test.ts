import { describe, expect, it } from 'vitest';
import type { EndDto } from '../../../../shared/contract';
import { impactLines, splitEnds } from './endLifecycle';

function end(id: string, status: string, name = id): EndDto {
  return {
    id,
    workspaceId: 'w1',
    family: 'dev',
    kind: 'android',
    name,
    status,
    roots: [`/repo/${id}`],
    createdAt: 0,
    archivedAt: status === 'archived' ? 1 : null,
    summary: '',
    notes: '',
    capabilities: [],
  };
}

describe('splitEnds', () => {
  it('keeps one active end and lists archived and draft separately', () => {
    const groups = splitEnds([end('a', 'active'), end('b', 'archived'), end('c', 'draft')]);
    expect(groups.active?.id).toBe('a');
    expect(groups.archived.map((item) => item.id)).toEqual(['b']);
    expect(groups.draft.map((item) => item.id)).toEqual(['c']);
  });

  it('reports no active end when everything is archived or draft', () => {
    const groups = splitEnds([end('b', 'archived'), end('c', 'draft')]);
    expect(groups.active).toBeNull();
    expect(groups.archived).toHaveLength(1);
  });
});

describe('impactLines', () => {
  it('renders counts and capability names', () => {
    const lines = impactLines({
      endId: 'a',
      status: 'active',
      explicitSessions: 2,
      cwdSessions: 3,
      capabilityBindings: 1,
      roots: 2,
      capabilities: ['Android 设备'],
    });
    expect(lines).toContain('显式指向该端的会话：2');
    expect(lines).toContain('工作目录位于端目录的会话：3');
    expect(lines).toContain('受影响能力：Android 设备');
  });

  it('explains when no capability binding exists', () => {
    const lines = impactLines({
      endId: 'a',
      status: 'active',
      explicitSessions: 0,
      cwdSessions: 0,
      capabilityBindings: 0,
      roots: 0,
      capabilities: [],
    });
    expect(lines).toContain('该端当前没有可用的能力绑定');
  });
});
