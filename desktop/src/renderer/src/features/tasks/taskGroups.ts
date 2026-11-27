import type { ScheduledTaskDto, WorkspaceDto } from '../../../../shared/contract';
import { workspaceLabel } from '../../store/workspaceList';

export interface TaskGroup {
  workspaceId: string;
  label: string;
  /** False when the workspace itself is disabled (or no longer exists). */
  enabled: boolean;
  tasks: ScheduledTaskDto[];
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function taskOrder(a: ScheduledTaskDto, b: ScheduledTaskDto): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const aNext = a.nextRunAt ?? Number.POSITIVE_INFINITY;
  const bNext = b.nextRunAt ?? Number.POSITIVE_INFINITY;
  if (aNext !== bNext) return aNext - bNext;
  return a.name.localeCompare(b.name);
}

/**
 * Global task list → workspace groups. The current workspace comes first (it is
 * the one the user just left), then the daemon's workspace order, then unknown
 * ids (a workspace deleted on another device). Empty groups are never created.
 */
export function groupTasksByWorkspace(
  tasks: ScheduledTaskDto[],
  workspaces: WorkspaceDto[],
  currentWorkspaceId: string | null,
): TaskGroup[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const order = new Map<string, number>();
  let index = 0;
  if (currentWorkspaceId && byId.has(currentWorkspaceId)) order.set(currentWorkspaceId, index++);
  for (const workspace of workspaces) {
    if (!order.has(workspace.id)) order.set(workspace.id, index++);
  }

  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    let group = groups.get(task.workspaceId);
    if (!group) {
      const workspace = byId.get(task.workspaceId);
      group = {
        workspaceId: task.workspaceId,
        label: workspaceLabel(workspace) ?? `未知工作区 · ${shortId(task.workspaceId)}`,
        enabled: workspace?.enabled ?? false,
        tasks: [],
      };
      groups.set(task.workspaceId, group);
    }
    group.tasks.push(task);
  }

  for (const group of groups.values()) group.tasks.sort(taskOrder);

  return [...groups.values()].sort((a, b) => {
    const aIndex = order.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = order.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.label.localeCompare(b.label);
  });
}
