import { useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { api } from '../../ipc/client';
import { RuntimeIcon } from '../../ui/RuntimeIcon';
import { defaultAgentId, permissionModeOptions, PERMISSION_MODE_LABEL } from '../../../../shared/runtime-identity';
import type { AgentDto, ProductPermissionMode } from '../../../../shared/contract';
import type { NewSessionOptions } from '../../store/chat';

interface Props {
  workspaceName: string | null;
  onCancel(): void;
  onCreate(options: NewSessionOptions): void;
}

/**
 * Creating a session is M1-critical: without it a fresh install has nothing to
 * open. The agent selector is the point of the whole product — running Claude,
 * Codex and DeepSeek Harness side by side from one client.
 */
export function NewSessionDialog({ workspaceName, onCancel, onCreate }: Props) {
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  const [mode, setMode] = useState<ProductPermissionMode>('ask');

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
        setRuntime(defaultAgentId(agentsRes.data.agents));
      }
      // A config failure is not fatal: fall back to the hard-coded 'ask'.
      if (configRes.ok) setMode(configRes.data.defaultPermissionMode);
    });
    return () => {
      live = false;
    };
  }, []);

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

  function submit(): void {
    if (!runtime) return;
    onCreate({ runtime, workspaceId: null, permissionMode: mode });
  }

  const modes = permissionModeOptions(runtime);
  const canSubmit = Boolean(runtime) && !noneAvailable;

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
          <label>Workspace</label>
          <div className="readonly mono">{workspaceName ?? '（未选择）'}</div>
          <div className="hint">会话在这个工作区内运行，不能在这里切换。</div>
        </div>

        <div className="field">
          <label>Agent</label>
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

        {noneAvailable && (
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
