import { useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { useConnection } from '../../store/connection';
import { useScope } from '../../store/sessions';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type {
  AgentProfileDetailDto,
  AgentProfileDto,
  AgentProfileRequest,
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
    setBusy(true);
    const res = await api.deleteAgentProfile(agent.id);
    if (!res.ok) setError(errorText(res));
    else setNotice(`已删除「${agent.name}」`);
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
                {agent.heavy && <span className="badge">外部 CLI</span>}
                {!agent.enabled && <span className="badge">已停用</span>}
                {agent.enabled && !agent.available && <span className="badge">当前离线</span>}
                <button
                  className="btn ghost"
                  style={{ marginLeft: 'auto' }}
                  disabled={busy}
                  onClick={() => (editing === agent.id ? setEditing(null) : startEdit(agent))}
                >
                  {editing === agent.id ? '取消' : '编辑'}
                </button>
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
