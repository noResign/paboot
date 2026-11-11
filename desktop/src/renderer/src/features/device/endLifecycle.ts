import type { EndDto, EndImpactDto } from '../../../../shared/contract';

export interface EndGroups {
  active: EndDto | null;
  archived: EndDto[];
  draft: EndDto[];
}

/** The panel drives one active end; archived/draft ends are separate rows. */
export function splitEnds(ends: readonly EndDto[]): EndGroups {
  return {
    active: ends.find((end) => end.status === 'active') ?? null,
    archived: ends.filter((end) => end.status === 'archived'),
    draft: ends.filter((end) => end.status === 'draft'),
  };
}

/** Human lines for the impact preview modal. */
export function impactLines(impact: EndImpactDto): string[] {
  const lines = [
    `显式指向该端的会话：${impact.explicitSessions}`,
    `工作目录位于端目录的会话：${impact.cwdSessions}`,
    `端目录：${impact.roots} 个`,
    `能力绑定：${impact.capabilityBindings} 个`,
  ];
  lines.push(
    impact.capabilities.length > 0
      ? `受影响能力：${impact.capabilities.join('、')}`
      : '该端当前没有可用的能力绑定',
  );
  return lines;
}

export function archiveConfirmLabel(name: string): string {
  return `归档端「${name}」？`;
}

export function deleteConfirmLabel(name: string): string {
  return `移除端「${name}」？`;
}
