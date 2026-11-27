import { describe, expect, it } from 'vitest';
import { groupTasksByWorkspace } from './taskGroups';
import type { ScheduledTaskDto, WorkspaceDto } from '../../../../shared/contract';

function ws(id: string, overrides: Partial<WorkspaceDto> = {}): WorkspaceDto {
  return {
    id,
    name: id,
    path: `/home/${id}`,
    dirs: [],
    shortcutDirs: [],
    isDefault: false,
    isBuiltin: false,
    enabled: true,
    sessionCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
}

function task(id: string, workspaceId: string, overrides: Partial<ScheduledTaskDto> = {}): ScheduledTaskDto {
  return {
    id,
    name: id,
    type: 'ai',
    sessionMode: 'new',
    sessionId: null,
    sessionTitle: null,
    workspaceId,
    runtime: 'claude',
    prompt: '',
    command: null,
    permissionMode: 'ask',
    schedule: { cron: '0 9 * * *', timezone: 'UTC', preset: null, label: '每天 09:00' },
    nextRunAt: null,
    lastFireAt: null,
    lastRunAt: null,
    lastStatus: 'never',
    lastError: null,
    lastRunId: null,
    runCount: 0,
    enabled: true,
    disabledReason: null,
    createdBy: 'user',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('groupTasksByWorkspace', () => {
  it('puts the current workspace first, then daemon order, then unknown ids', () => {
    const groups = groupTasksByWorkspace(
      [task('a', 'beta'), task('b', 'alpha'), task('c', 'gone')],
      [ws('alpha'), ws('beta')],
      'beta',
    );
    expect(groups.map((group) => group.workspaceId)).toEqual(['beta', 'alpha', 'gone']);
    expect(groups[2]?.label).toBe('未知工作区 · gone');
    expect(groups[2]?.enabled).toBe(false);
  });

  it('marks disabled workspaces and drops empty groups', () => {
    const groups = groupTasksByWorkspace(
      [task('a', 'off')],
      [ws('on'), ws('off', { enabled: false })],
      'on',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.enabled).toBe(false);
  });

  it('sorts enabled tasks first, then next run, then name', () => {
    const groups = groupTasksByWorkspace(
      [
        task('later', 'w', { nextRunAt: 20 }),
        task('paused', 'w', { enabled: false, nextRunAt: 1 }),
        task('sooner', 'w', { nextRunAt: 10 }),
        task('unscheduled', 'w', { nextRunAt: null }),
      ],
      [ws('w')],
      'w',
    );
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(['sooner', 'later', 'unscheduled', 'paused']);
  });
});
