import { useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { useConnection } from '../../store/connection';
import { useScope } from '../../store/sessions';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type {
  AgentProfileDetailDto,
  AgentProfileDto,
  AgentProfileRequest,
  PeerExposedAgentDto,
  WorkspaceDto,
} from '../../../../shared/contract';

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

const POLICY_LABEL: Record<string, string> = {
  relay: '对端用户批准',
  local_prompt: '本机批准',
  auto_deny: '一律拒绝',
};

/** v1 shares only the two backends whose read path the daemon can hard-restrict. */
function canShare(agent: AgentProfileDto): boolean {
  return agent.kind !== 'peer' && (agent.backend === 'builtin' || agent.backend === 'claude');
}

/**
 * Workspace-level agent definitions.
 *
 * This is the only place an assistant is *created*: a definition is reusable
 * across sessions, so it cannot belong to one room. A session's roster only
 * decides who takes part in that room and lets the user @ them.
 */
export function AgentSection() {
  const connectionId = useConnection((state) => state.activeId);
  const scope = useScope(connectionId);
  const workspaces = useMemo(() => scope.workspaces, [scope.workspaces]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentProfileDto[] | null>(null);
  /** The list DTO omits mechanism fields on purpose; the editor reads details. */
  const [details, setDetails] = useState<Record<string, AgentProfileDetailDto>>({});
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Inline editor for an existing definition; only name/summary are editable here. */
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; summary: string }>({
    name: '',
    summary: '',
  });
  /** Cross-machine sharing: loaded lazily when the row is expanded. */
  const [sharing, setSharing] = useState<string | null>(null);
  const [exposures, setExposures] = useState<Record<string, PeerExposedAgentDto | null>>({});
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  /** Add-a-remote-assistant form; connections are per agent, not per machine. */
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteLabel, setRemoteLabel] = useState('');
  const [remoteBusy, setRemoteBusy] = useState(false);

  const selected: WorkspaceDto | undefined =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0];

  useEffect(() => {
    if (workspaceId || workspaces.length === 0) return;
    setWorkspaceId(workspaces[0]!.id);
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (!connectionId) return;
    let live = true;
    void api.agents().then((res) => {
      if (!live || !res.ok) return;
      setRuntimes([
        { id: 'builtin', name: '内置（无需 CLI）', available: true },
        ...res.data.agents
          .filter((runtime) => runtime.id !== 'builtin')
          .map((runtime) => ({
            id: runtime.id,
            name: runtime.name || runtime.id,
            available: runtime.available,
          })),
      ]);
    });
    return () => {
      live = false;
    };
  }, [connectionId]);

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      runtime:
        current.runtime ||
        (runtimes.some((runtime) => runtime.id === selected?.defaultRuntime)
          ? (selected?.defaultRuntime ?? '')
          : (runtimes[0]?.id ?? 'builtin')),
    }));
  }, [runtimes, selected?.defaultRuntime]);

  async function load(): Promise<void> {
    if (!selected) {
      setAgents([]);
      return;
    }
    const res = await api.workspaceAgents(selected.id, true);
    if (!res.ok) {
      setError(`无法读取助手列表（HTTP ${res.status}）`);
      setAgents([]);
      return;
    }
    setAgents(res.data.agents);
    setError(null);

    // Mechanism fields (readOnly) only exist on the detail endpoint. Small N,
    // and only while this settings section is on screen.
    const loaded = await Promise.all(
      res.data.agents.map(async (agent) => {
        const detail = await api.agentProfile(agent.id);
        return detail.ok ? ([agent.id, detail.data.agent] as const) : null;
      }),
    );
    setDetails(Object.fromEntries(loaded.filter((entry) => entry !== null)));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  function errorText(res: { status: number; data: unknown }): string {
    const { apiCode, message } = apiErrorOf(res.data);
    return friendlyMessage(apiCode, res.status, message, '操作失败');
  }

  async function create(): Promise<void> {
    const name = draft.name.trim();
    if (!selected || !name) {
      setError('先给助手起个名字');
      return;
    }
    setBusy(true);
    setError(null);
    const body: AgentProfileRequest = {
      name,
      summary: draft.summary.trim() || undefined,
      kind: draft.runtime === 'builtin' ? 'builtin' : 'runtime',
      runtime: draft.runtime === 'builtin' ? null : draft.runtime,
      readOnly: draft.readOnly,
    };
    const res = await api.createAgentProfile(selected.id, body);
    if (!res.ok) {
      setError(errorText(res));
      setBusy(false);
      return;
    }
    setDraft((current) => ({ ...current, name: '', summary: '' }));
    setNotice(`已创建「${res.data.agent.name}」。在会话里输入 @ 即可把它拉进房间。`);
    await load();
    setBusy(false);
  }

  function startEdit(agent: AgentProfileDto): void {
    setEditing(agent.id);
    // The list DTO falls an empty summary back to the name; do not pre-fill that.
    setEditDraft({
      name: agent.name,
      summary: agent.summary === agent.name ? '' : agent.summary,
    });
    setError(null);
    setNotice(null);
  }

  async function saveEdit(agent: AgentProfileDto): Promise<void> {
    const name = editDraft.name.trim();
    if (!name) {
      setError('名字不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    const body: AgentProfileRequest = { name, summary: editDraft.summary.trim() };
    const res = await api.updateAgentProfile(agent.id, body);
    if (!res.ok) {
      setError(errorText(res));
      setBusy(false);
      return;
    }
    setEditing(null);
    setNotice(`已更新「${res.data.agent.name}」`);
    await load();
    setBusy(false);
  }

  async function setReadOnly(agent: AgentProfileDto, value: boolean): Promise<void> {
    setBusy(true);
    const body: AgentProfileRequest = { readOnly: value };
    const res = await api.updateAgentProfile(agent.id, body);
    if (!res.ok) setError(errorText(res));
    await load();
    setBusy(false);
  }

  async function remove(agent: AgentProfileDto): Promise<void> {
    const confirmed = window.confirm(
      `删除「${agent.name}」？\n\n所有会话里的这个助手也会被移除；历史消息会保留，显示为「已移除的助手」。`,
    );
    if (!confirmed) return;
    setBusy(true);
    const res = await api.deleteAgentProfile(agent.id);
    if (!res.ok) setError(errorText(res));
    else setNotice(`已删除「${agent.name}」`);
    await load();
    setBusy(false);
  }

  async function loadExposure(agentId: string): Promise<void> {
    const res = await api.peerExposure(agentId);
    if (res.ok) {
      setExposures((current) => ({ ...current, [agentId]: res.data }));
      return;
    }
    if (res.status === 404) {
      setExposures((current) => ({ ...current, [agentId]: null }));
      return;
    }
    setError(errorText(res));
  }

  function toggleShare(agent: AgentProfileDto): void {
    setError(null);
    setNotice(null);
    setInviteUrl(null);
    if (sharing === agent.id) {
      setSharing(null);
      return;
    }
    setSharing(agent.id);
    if (!(agent.id in exposures)) void loadExposure(agent.id);
  }

  async function enableShare(agent: AgentProfileDto, patch: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api.setPeerExposure(agent.id, patch);
    if (!res.ok) setError(errorText(res));
    else {
      setExposures((current) => ({ ...current, [agent.id]: res.data }));
      setNotice(
        res.data.enabled
          ? `「${agent.name}」已共享。把邀请链接交给对方，它就能使用这个助手的全部工具与上下文。`
          : `「${agent.name}」已暂停共享。`,
      );
    }
    setBusy(false);
  }

  async function makeInvite(agent: AgentProfileDto): Promise<void> {
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    const res = await api.createPeerInvite(agent.id, {});
    if (!res.ok) setError(errorText(res));
    else {
      setInviteUrl(res.data.url);
      setNotice('邀请 24 小时内有效，且只能用一次。');
    }
    setBusy(false);
  }

  async function revokeAll(agent: AgentProfileDto): Promise<void> {
    if (!window.confirm(`吊销「${agent.name}」的全部跨机连接？对方需要重新邀请。`)) return;
    setBusy(true);
    setError(null);
    const res = await api.revokePeerTokens(agent.id);
    if (!res.ok) setError(errorText(res));
    else {
      setNotice(`已吊销全部连接（${res.data.revoked} 个凭证）`);
      await loadExposure(agent.id);
    }
    setBusy(false);
  }

  async function joinRemote(): Promise<void> {
    if (!selected) return;
    const url = remoteUrl.trim();
    if (!url) {
      setError('先粘贴邀请链接');
      return;
    }
    setRemoteBusy(true);
    setError(null);
    setNotice(null);
    const res = await api.joinPeer({
      url,
      workspaceId: selected.id,
      ...(remoteLabel.trim() ? { label: remoteLabel.trim() } : {}),
    });
    if (!res.ok) {
      setError(errorText(res));
      setRemoteBusy(false);
      return;
    }
    setRemoteUrl('');
    setRemoteLabel('');
    setRemoteOpen(false);
    setNotice(
      `已添加远端助手「${res.data.agents[0]?.name ?? res.data.label}」。它现在也在助手列表里，用 @ 点名即可。`,
    );
    await load();
    setRemoteBusy(false);
  }

  async function probeRemote(agent: AgentProfileDto): Promise<void> {
    const peerId = details[agent.id]?.peerId;
    if (!peerId) return;
    setBusy(true);
    const res = await api.probePeer(peerId);
    if (!res.ok) setError(errorText(res));
    else setNotice(res.data.online ? '对方在线' : '对方没有响应');
    setBusy(false);
  }

  async function removeRemote(agent: AgentProfileDto): Promise<void> {
    const peerId = details[agent.id]?.peerId;
    if (!peerId) return;
    if (!window.confirm(`断开远端助手「${agent.name}」？这台机器与对方的连接会被删除。`)) return;
    setBusy(true);
    const res = await api.removePeer(peerId);
    if (!res.ok) setError(errorText(res));
    else setNotice(`已断开「${agent.name}」`);
    await load();
    setBusy(false);
  }

  return (
    <section className="settings-section">
      <h3>助手</h3>
      <div className="hint" style={{ marginTop: 0 }}>
        工作区级的助手定义。创建后不会自动进入任何会话——在会话里用 <b>@</b> 点名，
        它才会加入那个房间并回答。
      </div>

      {workspaces.length > 1 && (
        <div className="field">
          <label>工作区</label>
          <select
            className="model-select"
            value={selected?.id ?? ''}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field" style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={() => setRemoteOpen((open) => !open)}>
            {remoteOpen ? '取消添加远端助手' : '添加远端助手'}
          </button>
          <span className="hint" style={{ marginTop: 0 }}>
            远端助手也是助手；一个邀请对应一个助手。
          </span>
        </div>
        {remoteOpen && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 10,
              display: 'grid',
              gap: 6,
            }}
          >
            <div className="hint" style={{ marginTop: 0 }}>
              让对方在它的助手行点「共享」并生成邀请链接。只支持同一局域网、Tailscale 或 SSH
              隧道；加入后对方的助手会出现在这个工作区。
            </div>
            <input
              value={remoteUrl}
              placeholder="paboot://join?host=…&port=…&fp=…&t=…&exp=…"
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
            <input
              value={remoteLabel}
              placeholder="给它起个名字（可选），例如：公司那台"
              maxLength={40}
              onChange={(event) => setRemoteLabel(event.target.value)}
            />
            <div className="hint">
              ⚠ 它的回答由那台机器生成，消耗对方的额度；对方能使用它自己的全部工具与上下文。
            </div>
            <div>
              <button
                className="btn primary"
                disabled={remoteBusy || !remoteUrl.trim()}
                onClick={() => void joinRemote()}
              >
                {remoteBusy ? '正在连接…' : '添加'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="field" style={{ display: 'grid', gap: 8 }}>
        {agents === null ? (
          <div className="hint">正在读取助手…</div>
        ) : agents.length === 0 ? (
          <div className="hint">这个工作区还没有助手。</div>
        ) : (
          agents.map((agent) => (
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
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b>{agent.name}</b>
                {details[agent.id]?.isImplicit && <span className="badge">默认</span>}
                {agent.kind === 'peer' && <span className="badge">远程助手</span>}
                {agent.heavy && <span className="badge">外部 CLI</span>}
                {!agent.enabled && <span className="badge">已停用</span>}
                {agent.enabled && !agent.available && <span className="badge">当前离线</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {agent.kind === 'peer' ? (
                    <>
                      <button className="btn ghost" disabled={busy} onClick={() => void probeRemote(agent)}>
                        探活
                      </button>
                      <button className="btn ghost" disabled={busy} onClick={() => void removeRemote(agent)}>
                        断开
                      </button>
                    </>
                  ) : (
                    <>
                      {canShare(agent) && !details[agent.id]?.isImplicit && (
                        <button className="btn ghost" disabled={busy} onClick={() => toggleShare(agent)}>
                          {sharing === agent.id ? '收起共享' : '共享'}
                        </button>
                      )}
                      <button
                        className="btn ghost"
                        disabled={busy}
                        onClick={() => (editing === agent.id ? setEditing(null) : startEdit(agent))}
                      >
                        {editing === agent.id ? '取消' : '编辑'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {editing === agent.id ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <input
                    value={editDraft.name}
                    placeholder="名字，例如：审阅"
                    maxLength={40}
                    onChange={(event) =>
                      setEditDraft((current) => ({ ...current, name: event.target.value }))
                    }
                  />
                  <input
                    value={editDraft.summary}
                    placeholder="一句话简介"
                    maxLength={40}
                    onChange={(event) =>
                      setEditDraft((current) => ({ ...current, summary: event.target.value }))
                    }
                  />
                  <div>
                    <button
                      className="btn primary"
                      disabled={busy || !editDraft.name.trim()}
                      onClick={() => void saveEdit(agent)}
                    >
                      {busy ? '正在保存…' : '保存'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="hint">
                  {agent.summary || agent.backend}
                  {details[agent.id] && ` · ${details[agent.id]!.readOnly ? '只读' : '可写'}`}
                </div>
              )}
              {editing !== agent.id && details[agent.id] && !details[agent.id]!.isImplicit && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={details[agent.id]!.readOnly}
                      disabled={busy}
                      onChange={(event) => void setReadOnly(agent, event.target.checked)}
                    />
                    只读（不改代码）
                  </label>
                  <button className="btn" disabled={busy} onClick={() => void remove(agent)}>
                    删除
                  </button>
                </div>
              )}

              {sharing === agent.id && canShare(agent) && (
                <div
                  style={{
                    borderTop: '1px solid var(--border)',
                    paddingTop: 8,
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  {!(agent.id in exposures) ? (
                    <div className="hint">正在读取共享状态…</div>
                  ) : exposures[agent.id] === null ? (
                    <>
                      <div className="hint">
                        共享 = 对方能使用这个助手的<b>全部工具、上下文和记忆</b>。只共享给你愿意给出
                        shell 的人；v1 只支持同一局域网 / Tailscale / SSH 隧道。
                      </div>
                      <div>
                        <button
                          className="btn primary"
                          disabled={busy}
                          onClick={() => void enableShare(agent, {})}
                        >
                          开启共享
                        </button>
                      </div>
                    </>
                  ) : (
                    (() => {
                      const exposure = exposures[agent.id]!;
                      return (
                        <>
                          <div className="hint">
                            {exposure.enabled ? '已启用' : '已暂停'} · 审批：
                            {POLICY_LABEL[exposure.contract.approvalPolicy]} · 合同版本{' '}
                            {exposure.contract.version}
                          </div>
                          <label className="hint" style={{ display: 'flex', gap: 6 }}>
                            审批策略
                            <select
                              className="model-select"
                              value={exposure.contract.approvalPolicy}
                              disabled={busy}
                              onChange={(event) =>
                                void enableShare(agent, { approvalPolicy: event.target.value })
                              }
                            >
                              <option value="relay">对端用户批准（默认）</option>
                              <option value="auto_deny">一律拒绝（只读）</option>
                            </select>
                          </label>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              className="btn"
                              disabled={busy}
                              onClick={() => void enableShare(agent, { enabled: !exposure.enabled })}
                            >
                              {exposure.enabled ? '暂停共享' : '恢复共享'}
                            </button>
                            <button className="btn" disabled={busy} onClick={() => void makeInvite(agent)}>
                              生成邀请链接
                            </button>
                            <button className="btn" disabled={busy} onClick={() => void revokeAll(agent)}>
                              吊销全部连接
                            </button>
                          </div>
                          {inviteUrl && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <input readOnly value={inviteUrl} style={{ flex: 1 }} />
                              <button
                                className="btn"
                                onClick={() => void navigator.clipboard.writeText(inviteUrl)}
                              >
                                复制
                              </button>
                            </div>
                          )}
                          <div className="hint">
                            ⚠ 撤销只影响之后的调用；对方已经读到的内容和记忆收不回。
                          </div>
                        </>
                      );
                    })()
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="field" style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <label>新建助手</label>
        <div className="hint" style={{ marginTop: 0 }}>
          简介会展示给用户，也会进入其他 agent 的房间名册——写「能做什么」而不是「很强大」。
        </div>
        <input
          value={draft.name}
          placeholder="名字，例如：审阅"
          maxLength={40}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
        <input
          value={draft.summary}
          placeholder="一句话简介，例如：审查改动，指出问题，不改代码"
          maxLength={40}
          onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
        />
        <select
          className="model-select"
          value={draft.runtime}
          onChange={(event) => setDraft((current) => ({ ...current, runtime: event.target.value }))}
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
        <div>
          <button
            className="btn primary"
            disabled={busy || !draft.name.trim() || !draft.runtime}
            onClick={() => void create()}
          >
            {busy ? '正在处理…' : '创建'}
          </button>
        </div>
      </div>

      {notice && <div className="hint">{notice}</div>}
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
