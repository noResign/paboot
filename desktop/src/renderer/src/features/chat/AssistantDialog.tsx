import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import type { AgentProfileDto, SessionAgentDto } from '../../../../shared/contract';

interface Props {
  sessionId: string;
  onClose(): void;
}

/**
 * 会话的「助手」面板。
 *
 * 房间里有哪些助手、谁现在能用、谁已经有自己的对话，以及拉人进来 / 移出去 /
 * 重置某个人的对话。
 *
 * 两样东西刻意不显示：
 *   - **谁是主答**：对用户不可感知。新建会话时选的那个就是它，不需要一个标签，
 *     也不需要在这里换；
 *   - 机制字段（权限上限 / 只读 / 工具白名单）：那是 agent 编辑页的事，混进成员
 *     列表只会让人以为是房间级设置。
 */
export function AssistantDialog({ sessionId, onClose }: Props) {
  const [agents, setAgents] = useState<SessionAgentDto[] | null>(null);
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentProfileDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<SessionAgentDto | null>(null);

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

  useEffect(() => {
    void load();
    // 打开时顺手刷新候选池：用户可能刚在别处建过新 agent。
    void api.session(sessionId).then((res) => {
      if (!res.ok) return;
      const workspaceId = res.data.session.workspaceId;
      if (!workspaceId) return;
      void api.workspaceAgents(workspaceId).then((agentsRes) => {
        if (agentsRes.ok) setWorkspaceAgents(agentsRes.data.agents);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function run(action: () => Promise<{ ok: boolean; status: number; error?: string }>): Promise<void> {
    const res = await action();
    if (!res.ok) {
      setError(res.error ?? `操作失败（HTTP ${res.status}）`);
      return;
    }
    await load();
  }

  const addable = (agents ?? []).length
    ? workspaceAgents.filter((candidate) => !agents!.some((member) => member.id === candidate.id))
    : [];

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 520 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>助手</span>
          <button className="btn ghost" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {agents === null ? (
          <div className="hint">正在读取助手列表…</div>
        ) : (
          <>
            <div className="hint">{agents.length} 个助手</div>

            <div className="field" style={{ display: 'grid', gap: 8 }}>
              {agents.map((agent) => {
                return (
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
                    </div>
                    <div className="hint">
                      {/* 不可用要说清原因，否则用户只会看到「它不说话」。 */}
                      {!agent.available
                        ? agent.enabled
                          ? '当前离线'
                          : '已停用'
                        : agent.summary || agent.backend}
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
                );
              })}
            </div>

            {addable.length > 0 && (
              <div className="field">
                <label>添加助手</label>
                <div className="agent-picker">
                  {addable.map((candidate) => (
                    <button
                      key={candidate.id}
                      className="agent-option"
                      // 不可用的仍列出来但置灰：直接不显示会让人以为它被删了。
                      disabled={!candidate.available}
                      title={candidate.summary || candidate.backend}
                      onClick={() =>
                        void run(() => api.addSessionAgent(sessionId, candidate.id))
                      }
                    >
                      <span>{candidate.name}</span>
                      {!candidate.available && (
                        <span className="badge">{candidate.enabled ? '离线' : '已停用'}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
