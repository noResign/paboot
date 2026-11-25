import { useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { api } from '../../ipc/client';
import { RuntimeIcon } from '../../ui/RuntimeIcon';
import {
  clampPermissionMode,
  defaultAgentId,
  permissionModeOptions,
  PERMISSION_MODE_LABEL,
} from '../../../../shared/runtime-identity';
import { bypassAllowedOf, useConfig } from '../../store/config';
import type { AgentDto, AgentProfileDto, ProductPermissionMode } from '../../../../shared/contract';
import type { NewSessionOptions } from '../../store/chat';

interface Props {
  workspaceId: string | null;
  workspaceName: string | null;
  workspacePath: string | null;
  /** Workspace-level new-session defaults; null = follow global / claude. */
  defaultRuntime: string | null;
  defaultPermissionMode: ProductPermissionMode | null;
  onCancel(): void;
  onCreate(options: NewSessionOptions): void;
}

/**
 * Creating a session is M1-critical: without it a fresh install has nothing to
 * open. The agent selector is the point of the whole product — running Claude,
 * Codex and DeepSeek Harness side by side from one client.
 */
export function NewSessionDialog({
  workspaceId,
  workspaceName,
  workspacePath,
  defaultRuntime,
  defaultPermissionMode,
  onCancel,
  onCreate,
}: Props) {
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  /** Direct chat target; null = use a bare runtime instead of a defined assistant. */
  const [assistants, setAssistants] = useState<AgentProfileDto[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [mode, setMode] = useState<ProductPermissionMode>('ask');
  const storeBypassAllowed = bypassAllowedOf(useConfig((state) => state.config));
  const [bypassAllowed, setBypassAllowed] = useState(storeBypassAllowed);

  useEffect(() => {
    setBypassAllowed(storeBypassAllowed);
  }, [storeBypassAllowed]);

  useEffect(() => {
    if (!bypassAllowed) setMode((current) => clampPermissionMode(current, false));
  }, [bypassAllowed]);

  useEffect(() => {
    let live = true;
    // Both are needed before the form is usable, and loading them together is
    // what keeps the preset mode from racing a user who starts clicking early.
    void Promise.all([api.agents(), api.config()]).then(([agentsRes, configRes]) => {
      if (!live) return;
      if (!agentsRes.ok) {
        setError(`无法读取 Agent 列表（HTTP ${agentsRes.status}）`);
        setAgents([]);
      } else {
        setAgents(agentsRes.data.agents);
        const canUseWorkspaceDefault =
          defaultRuntime !== null &&
          agentsRes.data.agents.some((agent) => agent.id === defaultRuntime && agent.available);
        setRuntime(
          canUseWorkspaceDefault ? defaultRuntime : defaultAgentId(agentsRes.data.agents),
        );
      }
      // Workspace default wins; otherwise the daemon's global default; a config
      // failure is not fatal and falls back to the hard-coded 'ask'.
      const allowed = configRes.ok ? configRes.data.bypassAllowed : storeBypassAllowed;
      setBypassAllowed(allowed);
      setMode(
        clampPermissionMode(
          defaultPermissionMode ??
            (configRes.ok ? configRes.data.defaultPermissionMode : 'ask'),
          allowed,
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [defaultRuntime, defaultPermissionMode]);

  useEffect(() => {
    if (!workspaceId) {
      setAssistants([]);
      return;
    }
    let live = true;
    void api.workspaceAgents(workspaceId).then((res) => {
      if (!live) return;
      setAssistants(res.ok ? res.data.agents.filter((agent) => agent.enabled) : []);
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const available = agents?.filter((agent) => agent.available) ?? [];
  const noneAvailable = agents !== null && available.length === 0;
  const selectedAgent = assistants.find((agent) => agent.id === agentId) ?? null;
  const effectiveRuntime = selectedAgent ? selectedAgent.backend : runtime;
  // A remote assistant's freshness is a hint, not a hard gate: `available` is
  // only "seen in the last 5 minutes", and a run can still wake it.
  const agentUnavailable =
    selectedAgent !== null && selectedAgent.kind !== 'peer' && !selectedAgent.available;

  function submit(): void {
    if (!effectiveRuntime || agentUnavailable) return;
    onCreate({
      runtime: effectiveRuntime,
      workspaceId: null,
      permissionMode: mode,
      ...(selectedAgent ? { agentId: selectedAgent.id } : {}),
    });
  }

  const modes = permissionModeOptions(effectiveRuntime, bypassAllowed);
  const canSubmit = Boolean(effectiveRuntime) && (selectedAgent ? !agentUnavailable : !noneAvailable);

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal new-session-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>新建会话</span>
          <button className="btn ghost" title="关闭" onClick={onCancel}>
                <Icon name="x" size={15} />
              </button>
        </div>

        <div className="field">
          <label>工作区</label>
          <div className="readonly mono">{workspaceName ?? '（未选择）'}</div>
          <div className="hint">
            {workspacePath ? (
              <>
                会话在主目录 <span className="mono">{workspacePath}</span> 中运行；其他目录会自动作为
                这个工作区的附加目录。
              </>
            ) : (
              '会话在这个工作区内运行，不能在这里切换。'
            )}
          </div>
        </div>

        <div className="field">
          <label>直接和助手对话</label>
          <div className="agent-picker">
            <button
              className={`agent-option${agentId === null ? ' active' : ''}`}
              onClick={() => setAgentId(null)}
            >
              <Icon name="plus" size={14} />
              <span>不用助手（直接选运行时）</span>
            </button>
            {assistants.map((assistant) => (
              <button
                key={assistant.id}
                className={`agent-option${agentId === assistant.id ? ' active' : ''}`}
                disabled={assistant.kind !== 'peer' && !assistant.available}
                title={assistant.summary || assistant.backend}
                onClick={() => setAgentId(assistant.id)}
              >
                <RuntimeIcon id={assistant.backend} size={16} />
                <span>{assistant.name}</span>
                {assistant.kind === 'peer' && <span className="badge">远端</span>}
                {!assistant.available && (
                  <span className="badge">
                    {assistant.kind === 'peer' ? '可能离线' : '当前离线'}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="hint">
            选中后，这个会话以它为唯一助手，直接提问即可应答；不加 @ 也由它回答。
          </div>
        </div>

        {!selectedAgent && (
          <div className="field">
            <label>运行时</label>
            {agents === null ? (
            <div className="hint">正在读取 Agent 列表…</div>
          ) : (
            <div className="agent-picker">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  className={`agent-option${agent.id === runtime ? ' active' : ''}`}
                  disabled={!agent.available}
                  title={agent.available ? agent.bin : '未安装或不在 PATH 上'}
                  onClick={() => setRuntime(agent.id)}
                >
                  <RuntimeIcon id={agent.id} size={16} />
                  <span>{agent.name}</span>
                  {!agent.available && <span className="badge">未安装</span>}
                </button>
              ))}
            </div>
          )}
          <div className="hint">模型与推理强度用电脑端 Agent 的默认配置；建立会话后可在会话页切换模型。</div>
          </div>
        )}

        {selectedAgent?.kind === 'peer' ? (
          <div className="field">
            <label>权限模式</label>
            <div className="hint">由那台机器的共享合同决定（默认：对端用户批准写操作）。</div>
          </div>
        ) : (
        <div className="field">
          <label>权限模式</label>
          <div className="mode-picker">
            {modes.map((option) => (
              <button
                key={option.mode}
                className={`mode-option${option.mode === mode ? ' active' : ''}`}
                onClick={() => setMode(option.mode)}
              >
                <b>{PERMISSION_MODE_LABEL[option.mode]}</b>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
          {mode === 'bypass' && (
            <div className="error-text">⚠️ bypass 会跳过工具审批——这个会话里的操作将不再询问你。</div>
          )}
        </div>
        )}

        {!selectedAgent && noneAvailable && (
          <div className="error-text">
            本机没有可用的 agent，请先在电脑上安装并登录 Claude Code、Codex 或 DeepSeek Harness。
          </div>
        )}
        {error && <div className="error-text">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            创建
          </button>
        </div>
        <div className="hint">创建后再发第一条消息，会话才真正建立。</div>
      </div>
    </div>
  );
}
