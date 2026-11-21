import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type {
  AgentProfileDto,
  AgentProfileRequest,
  SessionAgentDto,
} from '../../../../shared/contract';

interface Props {
  sessionId: string;
  onClose(): void;
  /** Membership or workspace agents changed; the caller recounts the room. */
  onChanged?(): void;
}

interface RuntimeOption {
  id: string;
  name: string;
  available: boolean;
}

interface Draft {
  name: string;
  summary: string;
  runtime: string;
  readOnly: boolean;
}

const EMPTY_DRAFT: Draft = { name: '', summary: '', runtime: '', readOnly: true };

/**
 * 会话的「助手」面板。
 *
 * 房间里有哪些助手、谁现在能用、谁已经有自己的对话，以及拉人进来 / 新建 / 移出去 /
 * 重置某个人的对话。新建的助手是**工作区级**的定义，创建后顺手加进当前房间。
 *
 * 两样东西刻意不显示：
 *   - **谁是主答**：对用户不可感知。新建会话时选的那个就是它，不需要一个标签，
 *     也不需要在这里换；
 *   - 机制字段（权限上限 / 工具白名单）：那是 agent 编辑页的事，混进成员列表只会
 *     让人以为是房间级设置。只读除外 —— 它决定这个助手能不能加入已有主答者的房间，
 *     所以在新建时就要选。
 */
export function AssistantDialog({ sessionId, onClose, onChanged }: Props) {
  const [agents, setAgents] = useState<SessionAgentDto[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentProfileDto[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
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
    void (async () => {
      const sessionRes = await api.session(sessionId);
      if (!sessionRes.ok) return;
      const info = sessionRes.data.session;
      setWorkspaceId(info.workspaceId ?? null);

      // Runtime ids the daemon can actually drive; `builtin` is a driver but
      // not an adapter, so the inventory endpoint does not list it.
      const runtimesRes = await api.agents();
      const options: RuntimeOption[] = [
        { id: 'builtin', name: '内置（无需 CLI）', available: true },
        ...(runtimesRes.ok
          ? runtimesRes.data.agents
              .filter((runtime) => runtime.id !== 'builtin')
              .map((runtime) => ({
                id: runtime.id,
                name: runtime.name || runtime.id,
                available: runtime.available,
              }))
          : []),
      ];
      setRuntimes(options);
      setDraft((current) => ({
        ...current,
        runtime:
          current.runtime ||
          (options.some((option) => option.id === info.runtime)
            ? info.runtime
            : (options[0]?.id ?? 'builtin')),
      }));
      await reloadWorkspaceAgents();
    })();
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

  async function createAndAdd(): Promise<void> {
    const name = draft.name.trim();
    if (!workspaceId || !name) {
      setError('先给助手起个名字');
      return;
    }
    setCreating(true);
    setError(null);
    const body: AgentProfileRequest = {
      name,
      summary: draft.summary.trim() || undefined,
      kind: draft.runtime === 'builtin' ? 'builtin' : 'runtime',
      runtime: draft.runtime === 'builtin' ? null : draft.runtime,
      readOnly: draft.readOnly,
    };
    const created = await api.createAgentProfile(workspaceId, body);
    if (!created.ok) {
      setError(errorText(created));
      setCreating(false);
      return;
    }

    const added = await api.addSessionAgent(sessionId, created.data.agent.id);
    if (!added.ok) {
      // The definition exists at workspace level even if this room refused it;
      // say that plainly instead of making "create" look like it did nothing.
      setError(`已创建「${created.data.agent.name}」，但加入这个房间失败：${errorText(added)}`);
      await Promise.all([load(), reloadWorkspaceAgents()]);
      onChanged?.();
      setCreating(false);
      return;
    }

    setDraft((current) => ({ ...current, name: '', summary: '' }));
    await Promise.all([load(), reloadWorkspaceAgents()]);
    onChanged?.();
    setCreating(false);
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
        style={{ maxWidth: 560, maxHeight: '86vh', overflowY: 'auto' }}
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
            <div className="hint">{agents.length} 个助手 · 在输入框里用 @ 指定谁来回答</div>

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
                        onClick={() =>
                          void run(() => api.removeSessionAgent(sessionId, agent.id))
                        }
                      >
                        移出
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="field">
              <label>加入已有助手</label>
              {addable.length === 0 ? (
                <div className="hint">这个工作区还没有其他可加入的助手，在下面新建一个。</div>
              ) : (
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
              )}
            </div>

            <div className="field" style={{ display: 'grid', gap: 8 }}>
              <label>新建助手</label>
              <div className="hint" style={{ marginTop: 0 }}>
                工作区级的定义，创建后会直接加入这个房间；以后也可以放进别的会话。
              </div>
              <input
                value={draft.name}
                placeholder="名字，例如：审阅"
                maxLength={40}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
              <input
                value={draft.summary}
                placeholder="一句话简介（别的助手也会看到），例如：审查改动，指出问题，不改代码"
                maxLength={40}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, summary: event.target.value }))
                }
              />
              <select
                className="model-select"
                value={draft.runtime}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, runtime: event.target.value }))
                }
              >
                {runtimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id} disabled={!runtime.available}>
                    {runtime.name}
                    {runtime.available ? '' : '（不可用）'}
                  </option>
                ))}
              </select>
              <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={draft.readOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, readOnly: event.target.checked }))
                  }
                />
                只读（可以读代码、给建议，但不修改文件）
              </label>
              {!draft.readOnly && (
                <div className="hint" style={{ color: 'var(--warning, #b45309)' }}>
                  这个房间已经有可写的主答者：不勾选只读会被拒绝加入。
                </div>
              )}
              <div>
                <button
                  className="btn primary"
                  disabled={creating || !draft.name.trim() || !draft.runtime}
                  onClick={() => void createAndAdd()}
                >
                  {creating ? '正在创建…' : '创建并加入'}
                </button>
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
