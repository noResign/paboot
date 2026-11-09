import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { Icon } from '../../ui/Icon';
import type {
  MemoryClaimDto,
  MemoryDuplicateDto,
  MemorySearchHitDto,
  MemoryStatusDto,
  MemoryTimelineItemDto,
  WorkspaceMemoryDto,
} from '../../../../shared/contract';

interface Props {
  workspaceId: string;
  workspaceName: string;
  family?: 'dev' | 'life';
  onClose(): void;
}

type Tab = 'claims' | 'timeline' | 'search' | 'duplicates';

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

/** `validFrom` is when the fact started; null `validTo` means still valid. */
function validityLabel(claim: MemoryClaimDto): string {
  if (claim.validFrom === null && claim.validTo === null) return '未知';
  if (claim.validFrom !== null && claim.validTo !== null) {
    return `${dateLabel(claim.validFrom)} – ${dateLabel(claim.validTo)}`;
  }
  if (claim.validFrom !== null) return `${dateLabel(claim.validFrom)} 起`;
  return `至 ${dateLabel(claim.validTo)}`;
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
export function MemoryPanel({ workspaceId, workspaceName, family, onClose }: Props) {
  const scope = `workspace:${workspaceId}`;
  const [tab, setTab] = useState<Tab>('claims');
  const [claims, setClaims] = useState<MemoryClaimDto[]>([]);
  const [status, setStatus] = useState<MemoryStatusDto | null>(null);
  const [settings, setSettings] = useState<WorkspaceMemoryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<MemoryTimelineItemDto[]>([]);
  const [selectedTimelineId, setSelectedTimelineId] = useState<string | null>(null);
  const [serverQuery, setServerQuery] = useState('');
  const [searchHits, setSearchHits] = useState<MemorySearchHitDto[]>([]);
  const [selectedHitId, setSelectedHitId] = useState<string | null>(null);
  const [promoteClass, setPromoteClass] = useState<'portable' | 'personal' | 'life_only'>('portable');
  const [duplicates, setDuplicates] = useState<MemoryDuplicateDto[]>([]);
  const [selectedDuplicateId, setSelectedDuplicateId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [claimsRes, statusRes, settingsRes] = await Promise.all([
      api.memoryClaims(scope),
      api.memoryStatus(scope),
      api.workspaceMemory(workspaceId),
    ]);
    setLoading(false);
    // Settings load independently: an opt-in workspace must still render the
    // enable switch while claims/status legitimately return 400.
    if (settingsRes.ok) setSettings(settingsRes.data as WorkspaceMemoryDto);
    if (!claimsRes.ok) {
      const code = (claimsRes.data as { code?: string } | null)?.code;
      if (code === 'memory_not_enabled') {
        setClaims([]);
        setStatus(null);
        setError(null);
        return;
      }
      setError(errorMessage(claimsRes.data, claimsRes.status));
      return;
    }
    setError(null);
    if (statusRes.ok) setStatus(statusRes.data as MemoryStatusDto);
    setClaims((claimsRes.data as { claims: MemoryClaimDto[] }).claims);
  }, [scope, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'timeline') return;
    void api.memoryTimeline(scope).then((res) => {
      if (res.ok) {
        const items = (res.data as { items: MemoryTimelineItemDto[] }).items;
        setTimeline(items);
        setSelectedTimelineId((current) =>
          current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null,
        );
      }
    });
  }, [tab, scope]);

  useEffect(() => {
    if (tab !== 'duplicates') return;
    void api.memoryDuplicates(scope).then((res) => {
      if (res.ok) {
        const items = (res.data as { duplicates: MemoryDuplicateDto[] }).duplicates;
        setDuplicates(items);
        setSelectedDuplicateId((current) =>
          current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null,
        );
      }
    });
  }, [tab, scope]);

  async function resolveDuplicate(
    duplicate: MemoryDuplicateDto,
    action: 'merge' | 'distinct' | 'dismiss',
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api.resolveMemoryDuplicate(scope, duplicate.id, action);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice(action === 'merge' ? '已合并重复记忆' : action === 'distinct' ? '已确认不是重复' : '已忽略');
    setDuplicates((current) => current.filter((item) => item.id !== duplicate.id));
    setSelectedDuplicateId((current) => (current === duplicate.id ? null : current));
    if (action === 'merge') void load();
  }

  async function updateSettings(patch: Partial<WorkspaceMemoryDto>): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api.updateWorkspaceMemory(workspaceId, {
      enabled: patch.enabled,
      injectionEnabled: patch.injectionEnabled,
      profileMode: patch.profileMode,
      lifeReadable: patch.lifeReadable,
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setSettings(res.data as WorkspaceMemoryDto);
    setNotice('记忆设置已更新');
    void load();
  }

  async function searchMemory(): Promise<void> {
    const q = serverQuery.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    const res = await api.memorySearch(scope, q);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    const hits = (res.data as { hits: MemorySearchHitDto[] }).hits;
    setSearchHits(hits);
    setSelectedHitId(hits[0]?.id ?? null);
  }

  async function promote(claim: MemoryClaimDto): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api.promoteMemoryClaim(scope, claim.id, promoteClass);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice('已提升为全局记忆');
    void load();
  }

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
  const selectedTimeline = useMemo(
    () => timeline.find((item) => item.id === selectedTimelineId) ?? null,
    [timeline, selectedTimelineId],
  );
  const selectedHit = useMemo(
    () => searchHits.find((hit) => hit.id === selectedHitId) ?? null,
    [searchHits, selectedHitId],
  );
  const selectedDuplicate = useMemo(
    () => duplicates.find((item) => item.id === selectedDuplicateId) ?? null,
    [duplicates, selectedDuplicateId],
  );
  const groupSpecs = useMemo(
    () =>
      family === 'life'
        ? GROUPS
        : GROUPS.map((group) => (group.kind === 'fact' ? { ...group, label: '事实' } : group)),
    [family],
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
      groupSpecs.map((group) => ({
        ...group,
        claims: filtered.filter((claim) => claim.kind === group.kind).sort(compareClaims),
      })).filter((group) => group.claims.length > 0),
    [filtered, groupSpecs],
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
  const memoryDisabled = settings !== null && !settings.enabled;
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
              <h2>{family === 'life' ? '关于你' : '项目记忆'}</h2>
              <span className="kn-workspace-chip">{workspaceName}</span>
              {total > 0 && <span className="badge subtle">{total} 条</span>}
            </div>
            <p className="hint">
              {family === 'life'
                ? '自动整理的生活记忆；选中一条查看来源、改正或忘记。'
                : '这个工作区的长期记忆默认关闭；在上方启用后开始捕获与注入。'}
            </p>
          </div>
          <div className="kn-head-actions">
            <button className="icon-btn kn-close" title="关闭" aria-label="关闭" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="mem-tabs">
          <button className={`btn${tab === 'claims' ? ' primary' : ''}`} onClick={() => setTab('claims')}>
            记忆
          </button>
          <button className={`btn${tab === 'timeline' ? ' primary' : ''}`} onClick={() => setTab('timeline')}>
            时间线
          </button>
          <button className={`btn${tab === 'search' ? ' primary' : ''}`} onClick={() => setTab('search')}>
            搜索
          </button>
          <button
            className={`btn${tab === 'duplicates' ? ' primary' : ''}`}
            onClick={() => setTab('duplicates')}
          >
            重复
            {duplicates.length > 0 && <span className="badge subtle">{duplicates.length}</span>}
          </button>
          <span className="mem-spacer" />
          {settings && (
            <label className="mem-switch">
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={busy}
                onChange={(event) => void updateSettings({ enabled: event.target.checked })}
              />
              启用记忆
            </label>
          )}
          {settings?.enabled && (
            <label className="mem-switch">
              <input
                type="checkbox"
                checked={settings.injectionEnabled}
                disabled={busy}
                onChange={(event) =>
                  void updateSettings({ injectionEnabled: event.target.checked })
                }
              />
              注入
            </label>
          )}
          {settings?.enabled && family === 'life' && (
            <select
              className="mem-select"
              value={settings.profileMode ?? 'portable'}
              disabled={busy}
              onChange={(event) =>
                void updateSettings({
                  profileMode: event.target.value as 'off' | 'portable' | 'full',
                })
              }
            >
              <option value="off">画像关</option>
              <option value="portable">画像 portable</option>
              <option value="full">画像 full</option>
            </select>
          )}
          {settings?.enabled && family !== 'life' && (
            <label className="mem-switch">
              <input
                type="checkbox"
                checked={settings.lifeReadable === true}
                disabled={busy}
                onChange={(event) =>
                  void updateSettings({ lifeReadable: event.target.checked })
                }
              />
              允许生活读取
            </label>
          )}
        </div>

        <div className="mem-layout">
          <aside className="mem-sidebar">
            <div className="mem-status-line">
              <span className={`mem-dot${modelAvailable ? ' is-on' : ''}`} />
              <span>
                {memoryDisabled
                  ? '记忆未启用'
                  : statusUnavailable
                    ? '状态不可用'
                    : modelAvailable
                      ? '自动整理'
                      : model
                        ? '配置不可用'
                        : '仅记录'}
              </span>
              {!memoryDisabled && model && <span className="mem-model mono">{model}</span>}
              <span className="mem-spacer" />
              {!memoryDisabled && (
                <span className={`badge${pending > 0 ? '' : ' subtle'}`}>{pending} 待整理</span>
              )}
            </div>
            {memoryDisabled ? (
              <p className="hint mem-status-hint">
                勾选上方「启用记忆」后开始捕获、整理与注入。
              </p>
            ) : (
              !modelAvailable && (
                <p className="hint mem-status-hint">
                  {statusUnavailable
                    ? '记忆状态加载失败；列表仍可正常浏览。'
                    : model
                      ? '当前记忆模型不可用：请检查 Provider 的 Key、启用状态和模型目录。'
                      : '到「模型 Provider」勾选「用于记忆」后自动整理。'}
                </p>
              )
            )}

            <div className="mem-claims-pane" hidden={tab !== 'claims'}>
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
                  <span className="hint">
                    {memoryDisabled
                      ? '先在顶部勾选「启用记忆」，再正常聊天。'
                      : family === 'life'
                        ? '在「生活」里正常聊天即可，消息会在后台自动整理。'
                        : '正常聊天即可，消息会在后台自动整理。'}
                  </span>
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
            </div>

            {tab === 'timeline' && (
              <div className="mem-groups">
                {timeline.length === 0 ? (
                  <p className="hint">还没有时间线记录；跑完一个会记忆的会话后出现。</p>
                ) : (
                  timeline.map((item) => (
                    <button
                      key={`${item.kind}-${item.id}`}
                      className={`mem-row${selectedTimelineId === item.id ? ' is-active' : ''}`}
                      onClick={() => setSelectedTimelineId(item.id)}
                    >
                      <span className="mem-row-summary">{item.title}</span>
                      <span className="mem-row-meta">
                        <span className="mem-tag">
                          {item.kind === 'observation' ? '观察' : '摘要'}
                        </span>
                        {item.sessionId && (
                          <span className="mem-tag">
                            会话 {item.sessionId.replace(/-/g, '').slice(0, 4)}
                          </span>
                        )}
                        <span className="mem-row-date">
                          {relativeTime(item.at)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {tab === 'search' && (
              <>
                <div className="mem-search-wrap">
                  <Icon name="search" size={14} />
                  <input
                    className="mem-search"
                    placeholder="搜索全部记忆与知识"
                    value={serverQuery}
                    onChange={(event) => setServerQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void searchMemory();
                    }}
                  />
                </div>
                <button className="btn" onClick={() => void searchMemory()} disabled={busy}>
                  搜索
                </button>
                <div className="mem-groups">
                  {searchHits.length === 0 ? (
                    <p className="hint">输入关键词后回车。</p>
                  ) : (
                    searchHits.map((hit) => (
                      <button
                        key={`${hit.kind}-${hit.id}`}
                        className={`mem-row${selectedHitId === hit.id ? ' is-active' : ''}`}
                        onClick={() => setSelectedHitId(hit.id)}
                      >
                        <span className="mem-row-summary">{hit.title}</span>
                        <span className="mem-row-meta">
                          <span className="mem-tag">{hit.kind}</span>
                          {hit.files && hit.files.length > 0 && (
                            <span className="mem-tag">{hit.files.length} files</span>
                          )}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}

            {tab === 'duplicates' && (
              <div className="mem-groups">
                {duplicates.length === 0 ? (
                  <p className="hint">没有待审核的重复候选。</p>
                ) : (
                  duplicates.map((item) => (
                    <button
                      key={item.id}
                      className={`mem-row${selectedDuplicateId === item.id ? ' is-active' : ''}`}
                      onClick={() => setSelectedDuplicateId(item.id)}
                    >
                      <span className="mem-row-summary">{item.claimSummary}</span>
                      <span className="mem-row-meta">
                        <span className="mem-tag">相似 {Math.round(item.score * 100)}%</span>
                        <span className="mem-row-date">与「{item.duplicateSummary}」</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </aside>

          <section className="mem-detail">
            {notice && <div className="ws-notice mem-detail-notice">{notice}</div>}
            <div hidden={tab !== 'claims'}>
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
                      {groupSpecs.find((group) => group.kind === selected.kind)?.label ?? selected.kind}
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
                        <dt>生效</dt>
                        <dd>{validityLabel(selected)}</dd>
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
                {family === 'life' && selected.scope.startsWith('workspace:') && (
                  <div className="mem-actions mem-detail-actions">
                    <select
                      className="mem-select"
                      value={promoteClass}
                      disabled={busy}
                      onChange={(event) =>
                        setPromoteClass(
                          event.target.value as 'portable' | 'personal' | 'life_only',
                        )
                      }
                    >
                      <option value="portable">portable</option>
                      <option value="personal">personal</option>
                      <option value="life_only">life_only</option>
                    </select>
                    <button className="btn" disabled={busy} onClick={() => void promote(selected)}>
                      提升为全局记忆
                    </button>
                  </div>
                )}
                {family !== 'life' && selected.scope.startsWith('workspace:') && (
                  <p className="hint mem-detail-actions">
                    项目记忆只属于当前工作区，不能提升为全局画像。
                  </p>
                )}
              </article>
            )}
            </div>

            {tab === 'timeline' && (
              <article className="mem-detail-body">
                {selectedTimeline ? (
                  <>
                    <div className="mem-detail-head">
                      <div className="mem-badges">
                        <span className="badge subtle">
                          {selectedTimeline.kind === 'observation' ? '观察' : '会话摘要'}
                        </span>
                      </div>
                      <span className="mem-claim-id mono">
                        {relativeTime(selectedTimeline.at)}
                      </span>
                    </div>
                    <h3 className="mem-detail-title">{selectedTimeline.title}</h3>
                    {selectedTimeline.subtitle && (
                      <p className="mem-detail-object">{selectedTimeline.subtitle}</p>
                    )}
                    <section className="mem-evidence">
                      <h4>相关文件</h4>
                      {selectedTimeline.files.length === 0 ? (
                        <p className="hint">没有文件记录。</p>
                      ) : (
                        selectedTimeline.files.map((file) => (
                          <p key={file} className="mono">{file}</p>
                        ))
                      )}
                    </section>
                  </>
                ) : (
                  <div className="mem-detail-empty">
                    <Icon name="eye" size={24} />
                    <b>选择一条时间线</b>
                  </div>
                )}
              </article>
            )}

            {tab === 'search' && (
              <article className="mem-detail-body">
                {selectedHit ? (
                  <>
                    <div className="mem-detail-head">
                      <div className="mem-badges">
                        <span className="badge subtle">{selectedHit.kind}</span>
                      </div>
                      <span className="mem-claim-id mono">{relativeTime(Date.now())}</span>
                    </div>
                    <h3 className="mem-detail-title">{selectedHit.title}</h3>
                    <p className="mem-detail-object">{selectedHit.snippet}</p>
                    {selectedHit.path && (
                      <p className="mono hint">{selectedHit.path}</p>
                    )}
                    {selectedHit.files && selectedHit.files.length > 0 && (
                      <section className="mem-evidence">
                        <h4>相关文件</h4>
                        {selectedHit.files.map((file) => (
                          <p key={file} className="mono">{file}</p>
                        ))}
                      </section>
                    )}
                  </>
                ) : (
                  <div className="mem-detail-empty">
                    <Icon name="eye" size={24} />
                    <b>选择一条搜索结果</b>
                  </div>
                )}
              </article>
            )}

            {tab === 'duplicates' && (
              <article className="mem-detail-body">
                {selectedDuplicate ? (
                  <>
                    <div className="mem-detail-head">
                      <div className="mem-badges">
                        <span className="badge subtle">重复候选</span>
                        <span className="badge subtle">
                          相似 {Math.round(selectedDuplicate.score * 100)}%
                        </span>
                      </div>
                      <span className="mem-claim-id mono">{selectedDuplicate.method}</span>
                    </div>
                    <h3 className="mem-detail-title">{selectedDuplicate.claimSummary}</h3>
                    <p className="mem-detail-object">
                      与已有记忆「{selectedDuplicate.duplicateSummary}」可能重复。
                    </p>
                    <div className="mem-actions mem-detail-actions">
                      <button
                        className="btn primary"
                        disabled={busy}
                        onClick={() => void resolveDuplicate(selectedDuplicate, 'merge')}
                      >
                        合并
                      </button>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => void resolveDuplicate(selectedDuplicate, 'distinct')}
                      >
                        不是重复
                      </button>
                      <button
                        className="btn ghost"
                        disabled={busy}
                        onClick={() => void resolveDuplicate(selectedDuplicate, 'dismiss')}
                      >
                        忽略
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="mem-detail-empty">
                    <Icon name="eye" size={24} />
                    <b>选择一条候选</b>
                  </div>
                )}
              </article>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
