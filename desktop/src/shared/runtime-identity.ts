import type { AgentDto, ProductPermissionMode } from './contract';

/**
 * A runtime's UI identity: icon + brand colour + display name
 * (docs/ui/shared/design-principles.md §5.2). Adding an agent is one row in the table,
 * never a layout change.
 */
export type RuntimeIcon = 'robot' | 'terminal' | 'build';

export interface RuntimeIdentity {
  id: string;
  displayName: string;
  icon: RuntimeIcon;
  color: string;
}

const NEUTRAL_COLOR = '#8A949E';

const TABLE: Record<string, RuntimeIdentity> = {
  claude: { id: 'claude', displayName: 'Claude Code', icon: 'robot', color: '#D97757' },
  // A distinct icon, not just a distinct colour: with both showing the same
  // glyph the selector would be readable only by hue.
  codex: { id: 'codex', displayName: 'Codex', icon: 'terminal', color: '#10A37F' },
};

export function runtimeIdentity(id: string): RuntimeIdentity {
  return TABLE[id] ?? { id, displayName: id || 'agent', icon: 'build', color: NEUTRAL_COLOR };
}

/**
 * The agent to preselect when creating a session: the first one that is
 * actually installed. Taking `[0]` blindly would preselect the runtime that
 * happens to be registered first, which may well be the missing one.
 */
export function defaultAgentId(agents: AgentDto[]): string | null {
  return agents.find((agent) => agent.available)?.id ?? null;
}

export interface PermissionModeOption {
  mode: ProductPermissionMode;
  description: string;
}

/** The same saved mode has different execution semantics per runtime. */
export function permissionModeOptions(runtime: string | null | undefined): PermissionModeOption[] {
  switch (runtime) {
    case 'codex':
      return [
        { mode: 'ask', description: '工作区沙箱；不受信任的命令需要审批，工作区编辑可能自动执行' },
        { mode: 'acceptEdits', description: '工作区沙箱内的命令和编辑可自动执行；提权由 Codex 请求审批' },
        { mode: 'bypass', description: '关闭沙箱并跳过工具审批（高风险）' },
      ];
    case 'claude':
      return [
        { mode: 'ask', description: '修改类操作询问' },
        { mode: 'acceptEdits', description: '编辑自动放行，Bash 仍询问' },
        { mode: 'bypass', description: '全部通过（高风险）' },
      ];
    default:
      return [
        { mode: 'ask', description: '按 Agent 默认规则审批' },
        { mode: 'acceptEdits', description: '减少审批；部分 Agent 也会自动执行命令' },
        { mode: 'bypass', description: '跳过工具审批（高风险）' },
      ];
  }
}

export const PERMISSION_MODE_LABEL: Record<ProductPermissionMode, string> = {
  ask: '询问',
  acceptEdits: '自动放行编辑',
  bypass: '全部通过',
};
