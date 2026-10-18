import { useEffect, useState } from 'react';
import { api, type ClaudeSessionSummary } from '../../ipc/client';
import { RuntimeIcon } from '../../ui/RuntimeIcon';
import { defaultAgentId, permissionModeOptions, PERMISSION_MODE_LABEL } from '../../../../shared/runtime-identity';
import type { AgentDto, ProductPermissionMode } from '../../../../shared/contract';
import type { NewSessionOptions } from '../../store/chat';

interface Props {
  workspaceName: string | null;
  workspaceId: string | null;
  onCancel(): void;
  onCreate(options: NewSessionOptions): void;
}

type Tab = 'new' | 'resume';

/**
 * Creating a session is M1-critical: without it a fresh install has nothing to
 * open. The agent selector is the point of the whole product — running Claude
 * and Codex side by side from one client.
 *
 * Resuming a Claude Code session that was started on the machine itself (in the
 * TUI) is the other half: it is always Claude, so the agent picker does not
 * apply to it.
 */
export function NewSessionDialog({ workspaceName, workspaceId, onCancel, onCreate }: Props) {
  const [tab, setTab] = useState<Tab>('new');
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSessionSummary[] | null>(null);
  const [resuming, setResuming] = useState<ClaudeSessionSummary | null>(null);
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
    if (tab !== 'resume' || claudeSessions !== null) return;
    let live = true;
    void api.claudeSessions(workspaceId ?? undefined).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setClaudeSessions([]);
        return;
      }
      setClaudeSessions(res.data.sessions.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt));
    });
    return () => {
      live = false;
    };
  }, [tab, claudeSessions, workspaceId]);

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
  // 续接固定走 Claude，所以它只看 Claude 在不在——codex 可用救不了它。
  const claudeMissing = agents !== null && !available.some((agent) => agent.id === 'claude');

  function submit(): void {
    if (tab === 'resume') {
      if (!resuming) return;
      onCreate({
        runtime: 'claude',
        workspaceId: null,
        permissionMode: mode,
        claudeSessionId: resuming.sessionId,
        title: resuming.summary || null,
      });
      return;
    }
    if (!runtime) return;
    onCreate({ runtime, workspaceId: null, permissionMode: mode });
  }

  const modes = permissionModeOptions(tab === 'resume' ? 'claude' : runtime);
  const canSubmit =
    tab === 'resume' ? resuming !== null && !claudeMissing : Boolean(runtime) && !noneAvailable;

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal new-session-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>新建会话</span>
          <button className="btn ghost" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="tabs">
          <button className={`tab${tab === 'new' ? ' active' : ''}`} onClick={() => setTab('new')}>
            新建空会话
          </button>
          <button className={`tab${tab === 'resume' ? ' active' : ''}`} onClick={() => setTab('resume')}>
            续接本机 Claude 会话
          </button>
        </div>

        <div className="field">
          <label>Workspace</label>
          <div className="readonly mono">{workspaceName ?? '（默认工作区）'}</div>
          <div className="hint">会话在这个工作区内运行，不能在这里切换。</div>
        </div>

        {tab === 'new' ? (
          <>
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
          </>
        ) : (
          <div className="field">
            <label>本机 Claude 会话</label>
            {claudeSessions === null ? (
              <div className="hint">正在读取…</div>
            ) : claudeSessions.length === 0 ? (
              <div className="hint">这个工作区里没有找到本机的 Claude Code 会话。</div>
            ) : (
              <ul className="claude-session-list">
                {claudeSessions.slice(0, 50).map((session) => (
                  <li key={session.sessionId}>
                    <button
                      className={`claude-session${resuming?.sessionId === session.sessionId ? ' active' : ''}`}
                      onClick={() => setResuming(session)}
                    >
                      <span className="claude-session-title">{session.summary || '(无摘要)'}</span>
                      <span className="hint mono">
                        {session.messageCount} 条 · {relativeTime(session.lastActiveAt)}
                      </span>
                      <span className="hint mono">{session.cwd}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="hint">续接的固定是 Claude 会话，不受 Agent 选择影响。</div>
          </div>
        )}

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

        {noneAvailable && tab === 'new' && (
          <div className="error-text">
            本机没有可用的 agent，请先在电脑上安装并登录 Claude Code 或 Codex。
          </div>
        )}
        {claudeMissing && tab === 'resume' && (
          <div className="error-text">本机没有可用的 Claude Code，无法续接会话。</div>
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

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return new Date(ts).toLocaleDateString();
}
