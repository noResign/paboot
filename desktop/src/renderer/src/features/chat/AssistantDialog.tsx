import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type { AgentProfileDto, SessionAgentDto } from '../../../../shared/contract';

interface Props {
  sessionId: string;
  onClose(): void;
  /** Membership changed; the caller recounts the room. */
  onChanged?(): void;
}

/**
 * 会话的「助手」面板：这个房间里**引入了谁**，各自现在什么状态。
 *
 * 这里**不创建** agent —— agent 是工作区级的定义，创建入口在「设置 → 助手」。
 * 会话只决定谁参与：用 @ 点名（会自动加入），或从这里把工作区里已有的助手拉进来。
 *
 * 刻意不显示「谁是主答」：新建会话时选的那个就是它，对用户不可感知，也不需要换。
 */
export function AssistantDialog({ sessionId, onClose, onChanged }: Props) {
  const [agents, setAgents] = useState<SessionAgentDto[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentProfileDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<SessionAgentDto | null>(null);

  function errorText(res: { status: number; data: unknown }): string {
    const { apiCode, message } = apiErrorOf(res.data);
    return friendlyMessage(apiCode, res.status, message, '操作失败');
  }

  async function load(): Promise<void> {
    const res = await api.sessionAgents(sessionId);
    if (!res.ok) {
      setError(`无法读取助手列表（HTTP ${res.status}）`);
      setAgents([]);
      return;
    }
    setAgents(res.data.agents);
    setError(null);
  }

  async function reloadWorkspaceAgents(): Promise<void> {
    if (!workspaceId) return;
    const res = await api.workspaceAgents(workspaceId);
    if (res.ok) setWorkspaceAgents(res.data.agents);
  }

  useEffect(() => {
    void load();
    void api.session(sessionId).then((res) => {
      if (!res.ok) return;
      const id = res.data.session.workspaceId;
      if (!id) return;
      setWorkspaceId(id);
      void api.workspaceAgents(id).then((agentsRes) => {
        if (agentsRes.ok) setWorkspaceAgents(agentsRes.data.agents);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function run(
    action: () => Promise<{ ok: boolean; status: number; data: unknown }>,
  ): Promise<void> {
    const res = await action();
    if (!res.ok) {
      setError(errorText(res));
      return;
    }
    setError(null);
    await Promise.all([load(), reloadWorkspaceAgents()]);
    onChanged?.();
  }

  const addable = (agents ?? []).length
    ? workspaceAgents.filter((candidate) => !agents!.some((member) => member.id === candidate.id))
    : [];

  function busyLabel(agent: SessionAgentDto): string | null {
    if (agent.taskStatus === 'running') return '正在回答';
    if (agent.taskStatus === 'queued') return '排队中';
    return null;
  }

  function descriptionOf(agent: SessionAgentDto): string {
    if (!agent.available) return agent.enabled ? '当前离线' : '已停用';
    return agent.summary || agent.backend;
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 540, maxHeight: '84vh', overflowY: 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>这个房间的助手</span>
          <button className="btn ghost" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {agents === null ? (
          <div className="hint">正在读取助手列表…</div>
        ) : (
          <>
            <div className="hint">
              {agents.length} 个助手 · 输入框里用 @ 点名；点名工作区里的其他助手会把它们拉进房间。
            </div>

            <div className="field" style={{ display: 'grid', gap: 8 }}>
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="field"
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: 10,
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <b>{agent.name}</b>
                    {agent.heavy && <span className="badge">外部 CLI</span>}
                    {busyLabel(agent) && <span className="badge">{busyLabel(agent)}</span>}
                  </div>
                  <div className="hint">
                    {descriptionOf(agent)}
                    {agent.hasContext ? ' · 已有自己的对话' : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {agent.hasContext && (
                      <button className="btn" onClick={() => setConfirmReset(agent)}>
                        重置对话
                      </button>
                    )}
                    {/* 主答移不掉（daemon 会 409）：它是这个会话的归属者，
                        而 UI 没有「换主答」的入口 —— 那是刻意的，对用户不可感知。 */}
                    <button
                      className="btn"
                      onClick={() => void run(() => api.removeSessionAgent(sessionId, agent.id))}
                    >
                      移出
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="field">
              <label>拉入已有助手</label>
              {addable.length === 0 ? (
                <div className="hint">
                  这个工作区没有其他可加入的助手。新的助手在 <b>设置 → 助手</b> 里创建。
                </div>
              ) : (
                <div className="agent-picker">
                  {addable.map((candidate) => (
                    <button
                      key={candidate.id}
                      className="agent-option"
                      // 不可用的仍列出来但置灰：直接不显示会让人以为它被删了。
                      disabled={!candidate.available}
                      title={candidate.summary || candidate.backend}
                      onClick={() => void run(() => api.addSessionAgent(sessionId, candidate.id))}
                    >
                      <span>{candidate.name}</span>
                      {!candidate.available && (
                        <span className="badge">{candidate.enabled ? '离线' : '已停用'}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="hint">
                一个房间最多一个可写助手（主答者）；其他成员以只读身份加入。
              </div>
            </div>
          </>
        )}

        {error && <div className="error-text">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {confirmReset && (
        <div className="modal-scrim" onClick={() => setConfirmReset(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>重置「{confirmReset.name}」的对话？</span>
            </div>
            <div className="hint">
              它的历史记录会保留，但下一次发言会从新对话开始。
              <br />
              <br />
              这不会清掉 runtime 自己保存的记忆（例如 Claude 的项目记忆）—— 那部分不归 paboot 管。
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmReset(null)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const target = confirmReset;
                  setConfirmReset(null);
                  void run(() => api.resetAgentContext(sessionId, target.id));
                }}
              >
                重置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
