import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { Icon } from '../../ui/Icon';
import type { MemoryClaimDto, MemoryStatusDto } from '../../../../shared/contract';

interface Props {
  workspaceId: string;
  workspaceName: string;
  onClose(): void;
}

const GROUPS: Array<{ kind: MemoryClaimDto['kind']; label: string }> = [
  { kind: 'fact', label: '关于你' },
  { kind: 'preference', label: '偏好' },
  { kind: 'relation', label: '关系' },
  { kind: 'profile', label: '画像' },
];

const AUTHORITY_LABEL: Record<MemoryClaimDto['authority'], string> = {
  user_confirmed: '你已确认',
  derived: '自动整理',
};

interface Draft {
  id: string;
  summary: string;
  objectText: string;
}

function shortClaimId(id: string): string {
  return id.replace(/-/g, '').slice(0, 4);
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; message?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message;
    if (typeof record.error === 'string' && record.error) return record.error;
  }
  return `请求失败（HTTP ${status}）`;
}

function relativeTime(timestamp: number | null): string {
  if (!timestamp) return '还没整理过';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function dateLabel(timestamp: number | null): string {
  if (timestamp === null) return '—';
  return new Date(timestamp).toLocaleDateString();
}

function compareClaims(a: MemoryClaimDto, b: MemoryClaimDto): number {
  const authority = (claim: MemoryClaimDto) => (claim.authority === 'user_confirmed' ? 1 : 0);
  return (
    authority(b) - authority(a) ||
    b.importance - a.importance ||
    b.updatedAt - a.updatedAt
  );
}

/**
 * 「关于你」(M0): grouped, compact list + detail pane. The old card-per-claim
 * list expanded every source quote inline, which made scanning dozens of
 * claims slow; source and actions now live in the selected item's detail.
 */
export function MemoryPanel({ workspaceId, workspaceName, onClose }: Props) {
  const scope = `workspace:${workspaceId}`;
  const [claims, setClaims] = useState<MemoryClaimDto[]>([]);
  const [status, setStatus] = useState<MemoryStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [claimsRes, statusRes] = await Promise.all([
      api.memoryClaims(scope),
      api.memoryStatus(scope),
    ]);
    setLoading(false);
    if (!claimsRes.ok) {
      setError(errorMessage(claimsRes.data, claimsRes.status));
      return;
    }
    if (statusRes.ok) setStatus(statusRes.data as MemoryStatusDto);
    setClaims((claimsRes.data as { claims: MemoryClaimDto[] }).claims);
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (claims.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !claims.some((claim) => claim.id === selectedId)) {
      setSelectedId(claims[0]!.id);
    }
  }, [claims, selectedId]);

  const selected = useMemo(
    () => claims.find((claim) => claim.id === selectedId) ?? null,
    [claims, selectedId],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return claims;
    return claims.filter((claim) => {
      const haystack = [
        claim.summary,
        claim.objectText ?? '',
        claim.predicate,
        ...claim.evidence.map((item) => item.quote ?? ''),
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [claims, query]);

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        claims: filtered.filter((claim) => claim.kind === group.kind).sort(compareClaims),
      })).filter((group) => group.claims.length > 0),
    [filtered],
  );

  function select(claim: MemoryClaimDto): void {
    setSelectedId(claim.id);
    setDraft(null);
    setForgetId(null);
    setError(null);
  }

  function toggleGroup(kind: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function startEdit(claim: MemoryClaimDto): void {
    setDraft({
      id: claim.id,
      summary: claim.summary,
      objectText: claim.objectText ?? '',
    });
    setForgetId(null);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const res = await api.correctMemoryClaim(scope, draft.id, {
      summary: draft.summary.trim(),
      objectText: draft.objectText.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setDraft(null);
    setNotice('已改正，之后以你确认的为准');
    void load();
  }

  async function forget(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api.forgetMemoryClaim(scope, id);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setForgetId(null);
    setNotice('已忘记');
    void load();
  }

  const pending = status?.pendingSources ?? 0;
  const statusUnavailable = status === null;
  const model = status?.extractionModel;
  const modelAvailable = status?.modelAvailable === true && Boolean(model);
  const total = claims.length;

  return (
    <div
      className="kn-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="关于你"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="kn-panel mem-panel">
        <header className="kn-head">
          <div className="kn-head-copy">
            <div className="kn-head-title">
              <h2>关于你</h2>
              <span className="kn-workspace-chip">{workspaceName}</span>
              {total > 0 && <span className="badge subtle">{total} 条</span>}
            </div>
            <p className="hint">
              自动整理的生活记忆；选中一条查看来源、改正或忘记。
            </p>
          </div>
          <div className="kn-head-actions">
            <button className="icon-btn kn-close" title="关闭" aria-label="关闭" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="mem-layout">
          <aside className="mem-sidebar">
            <div className="mem-status-line">
              <span className={`mem-dot${modelAvailable ? ' is-on' : ''}`} />
              <span>
                {statusUnavailable
                  ? '状态不可用'
                  : modelAvailable
                    ? '自动整理'
                    : model
                      ? '配置不可用'
                      : '仅记录'}
              </span>
              {model && <span className="mem-model mono">{model}</span>}
              <span className="mem-spacer" />
              <span className={`badge${pending > 0 ? '' : ' subtle'}`}>{pending} 待整理</span>
            </div>
            {!modelAvailable && (
              <p className="hint mem-status-hint">
                {statusUnavailable
                  ? '记忆状态加载失败；列表仍可正常浏览。'
                  : model
                    ? '当前记忆模型不可用：请检查 Provider 的 Key、启用状态和模型目录。'
                    : '到「模型 Provider」勾选「用于记忆」后自动整理。'}
              </p>
            )}

            <div className="mem-search-wrap">
              <Icon name="search" size={14} />
              <input
                className="mem-search"
                placeholder="搜索摘要、内容或来源原话"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {error && <p className="mem-error">{error}</p>}

            <div className="mem-groups">
              {loading ? (
                <p className="hint">加载中…</p>
              ) : claims.length === 0 ? (
                <div className="mem-empty">
                  <Icon name="eye" size={20} />
                  <b>还没有记忆</b>
                  <span className="hint">在「生活」里正常聊天即可，消息会在后台自动整理。</span>
                </div>
              ) : groups.length === 0 ? (
                <p className="hint">没有匹配的记忆。</p>
              ) : (
                groups.map((group) => {
                  const isCollapsed = collapsed.has(group.kind);
                  return (
                    <section className="mem-group" key={group.kind}>
                      <button
                        className="mem-group-head"
                        onClick={() => toggleGroup(group.kind)}
                      >
                        <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                        <span>{group.label}</span>
                        <span className="mem-group-count">{group.claims.length}</span>
                      </button>
                      {!isCollapsed && (
                        <div className="mem-rows">
                          {group.claims.map((claim) => (
                            <button
                              key={claim.id}
                              className={`mem-row${selectedId === claim.id ? ' is-active' : ''}`}
                              onClick={() => select(claim)}
                            >
                              <span className="mem-row-summary">{claim.summary}</span>
                              <span className="mem-row-meta">
                                <span
                                  className={
                                    claim.authority === 'user_confirmed'
                                      ? 'mem-tag is-confirmed'
                                      : 'mem-tag'
                                  }
                                >
                                  {AUTHORITY_LABEL[claim.authority]}
                                </span>
                                {claim.sensitivity === 'private' && (
                                  <span className="mem-tag">私密</span>
                                )}
                                <span className="mem-row-date">
                                  {relativeTime(claim.updatedAt)}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })
              )}
            </div>
          </aside>

          <section className="mem-detail">
            {notice && <div className="ws-notice mem-detail-notice">{notice}</div>}
            {!selected ? (
              <div className="mem-detail-empty">
                <Icon name="eye" size={24} />
                <b>选择一条记忆</b>
                <span className="hint">右侧会显示来源原话、置信度和改正 / 忘记操作。</span>
              </div>
            ) : (
              <article className="mem-detail-body">
                <div className="mem-detail-head">
                  <div className="mem-badges">
                    <span className="badge subtle">
                      {GROUPS.find((group) => group.kind === selected.kind)?.label ?? selected.kind}
                    </span>
                    <span
                      className={`badge${selected.authority === 'user_confirmed' ? '' : ' subtle'}`}
                    >
                      {AUTHORITY_LABEL[selected.authority]}
                    </span>
                    {selected.sensitivity === 'private' && (
                      <span className="badge subtle">私密</span>
                    )}
                  </div>
                  <span className="mem-claim-id mono">#claim_{shortClaimId(selected.id)}</span>
                </div>

                {draft?.id === selected.id ? (
                  <div className="mem-edit">
                    <label>
                      摘要
                      <textarea
                        value={draft.summary}
                        onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                      />
                    </label>
                    <label>
                      内容
                      <textarea
                        value={draft.objectText}
                        onChange={(event) => setDraft({ ...draft, objectText: event.target.value })}
                      />
                    </label>
                    <div className="mem-actions">
                      <button className="btn primary" onClick={() => void save()} disabled={busy}>
                        保存改正
                      </button>
                      <button className="btn" onClick={() => setDraft(null)} disabled={busy}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h3 className="mem-detail-title">{selected.summary}</h3>
                    {selected.objectText && selected.objectText !== selected.summary && (
                      <p className="mem-detail-object">{selected.objectText}</p>
                    )}

                    <dl className="mem-meta-grid">
                      <div>
                        <dt>置信度</dt>
                        <dd>{Math.round(selected.confidence * 100)}%</dd>
                      </div>
                      <div>
                        <dt>重要度</dt>
                        <dd>{Math.round(selected.importance * 100)}%</dd>
                      </div>
                      <div>
                        <dt>更新</dt>
                        <dd>{dateLabel(selected.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt>有效期</dt>
                        <dd>{dateLabel(selected.validFrom)}</dd>
                      </div>
                    </dl>

                    <section className="mem-evidence">
                      <h4>来源原话</h4>
                      {selected.evidence.length === 0 ? (
                        <p className="hint">这条记忆没有可展示的来源。</p>
                      ) : (
                        selected.evidence.map((item) => (
                          <blockquote key={`${item.sourceId}-${item.relation}`}>
                            “{item.quote ?? '（无原话）'}”
                          </blockquote>
                        ))
                      )}
                    </section>

                    <div className="mem-actions mem-detail-actions">
                      {forgetId === selected.id ? (
                        <>
                          <span className="hint">忘记后会删除这条记忆并阻止重新抽取。</span>
                          <button
                            className="btn danger"
                            onClick={() => void forget(selected.id)}
                            disabled={busy}
                          >
                            确认忘记
                          </button>
                          <button className="btn" onClick={() => setForgetId(null)} disabled={busy}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn" onClick={() => startEdit(selected)}>
                            改正
                          </button>
                          <button className="btn ghost" onClick={() => setForgetId(selected.id)}>
                            忘记
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </article>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
