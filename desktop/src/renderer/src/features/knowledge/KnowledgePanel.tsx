import { useCallback, useEffect, useRef, useState } from 'react';
import { api, exportKnowledge } from '../../ipc/client';
import { Icon } from '../../ui/Icon';
import type {
  KnowledgeDocDetailDto,
  KnowledgeDocDto,
  KnowledgeDocumentKind,
} from '../../../../shared/contract';

interface Props {
  workspaceId: string;
  workspaceName: string;
  onClose(): void;
}

const KINDS: Array<{ id: KnowledgeDocumentKind; label: string }> = [
  { id: 'workspace_context', label: '工作区总览' },
  { id: 'convention', label: '规范' },
  { id: 'requirement', label: '需求' },
  { id: 'tech_doc', label: '技术文档' },
  { id: 'adr', label: 'ADR' },
  { id: 'decision', label: '决策' },
  { id: 'gotcha', label: '踩坑' },
  { id: 'contract', label: '契约' },
  { id: 'runbook', label: 'Runbook' },
  { id: 'note', label: '笔记' },
];

type KnowledgeFilter = 'all' | 'unverified' | 'verified' | 'missing';

const FILTERS: Array<{ id: KnowledgeFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'unverified', label: '未核验' },
  { id: 'verified', label: '已核验' },
  { id: 'missing', label: '缺失' },
];

interface FormState {
  title: string;
  kind: KnowledgeDocumentKind;
  endId: string;
  tags: string;
  summary: string;
  body: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  kind: 'note',
  endId: '',
  tags: '',
  summary: '',
  body: '',
};

function formFrom(detail: KnowledgeDocDetailDto): FormState {
  return {
    title: detail.title,
    kind: detail.kind,
    endId: detail.endId ?? '',
    tags: detail.tags.join(', '),
    summary: detail.summary ?? '',
    body: detail.body,
  };
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; message?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message;
    if (typeof record.error === 'string' && record.error) return record.error;
  }
  return `请求失败（HTTP ${status}）`;
}

function isVerified(doc: KnowledgeDocDto): boolean {
  return doc.authority === 'curated';
}

/**
 * K0 knowledge manager. Knowledge is collected automatically; the only
 * governance state is the human-verification marker. Editing or verifying marks
 * a document verified; an external content change resets it to unverified.
 */
export function KnowledgePanel({ workspaceId, workspaceName, onClose }: Props) {
  const [filter, setFilter] = useState<KnowledgeFilter>('all');
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState<KnowledgeDocDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDocDetailDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [customKind, setCustomKind] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tab switches keep the previous list visible and only swap it when the new
  // result lands. Sequence numbers also drop responses from a stale filter, so
  // a slow request cannot overwrite the tab the user is looking at now.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const res = await api.knowledge(workspaceId, {
      verified: filter === 'unverified' ? false : filter === 'verified' ? true : undefined,
      status: filter === 'missing' ? 'missing' : undefined,
      q: query.trim() || undefined,
    });
    if (seq !== requestSeq.current) return;
    setLoading(false);
    setLoadedOnce(true);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setError(null);
    setDocuments((res.data as { documents: KnowledgeDocDto[] }).documents);
  }, [workspaceId, filter, query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      if (showCreateMenu) {
        setShowCreateMenu(false);
        return;
      }
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showCreateMenu]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  async function open(doc: KnowledgeDocDto): Promise<void> {
    setCreating(false);
    setSelectedId(doc.id);
    setError(null);
    const res = await api.knowledgeDoc(workspaceId, doc.id);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    const loaded = (res.data as { document: KnowledgeDocDetailDto }).document;
    setDetail(loaded);
    setForm(formFrom(loaded));
  }

  function openCreateMenu(): void {
    setShowCreateMenu(true);
  }

  function startCreate(
    kind: KnowledgeDocumentKind,
    options: { custom?: boolean; title?: string } = {},
  ): void {
    setCreating(true);
    setCustomKind(options.custom === true);
    setShowCreateMenu(false);
    setSelectedId(null);
    setDetail(null);
    setForm({ ...EMPTY_FORM, kind, title: options.title ?? '' });
    setError(null);
  }

  async function startWithPreset(
    kind: 'convention' | 'note' | 'requirement',
  ): Promise<void> {
    if (kind === 'convention') {
      const res = await api.knowledge(workspaceId, {});
      if (res.ok) {
        const existing = (res.data as { documents: KnowledgeDocDto[] }).documents.find(
          (doc) => doc.kind === 'convention' && doc.endId === null,
        );
        if (existing) {
          setShowCreateMenu(false);
          setNotice('规范文档已存在，已打开现有文档');
          void open(existing);
          return;
        }
      }
    }
    startCreate(kind, kind === 'convention' ? { title: '开发约定' } : {});
  }

  async function save(): Promise<void> {
    const title = form.title.trim();
    if (!title) {
      setError('标题不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      title,
      body: form.body,
      kind: form.kind,
      endId: form.endId.trim() || null,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      summary: form.summary.trim() || null,
    };
    const res = creating
      ? await api.createKnowledgeDoc(workspaceId, body)
      : selectedId
        ? await api.updateKnowledgeDoc(workspaceId, selectedId, body)
        : null;
    setBusy(false);
    if (!res) return;
    if (!res.ok) {
      const data = res.data as { code?: unknown; document?: KnowledgeDocDto } | null;
      if (data && data.code === 'knowledge_convention_exists' && data.document) {
        setCreating(false);
        setNotice('规范文档已存在，已打开现有文档');
        void open(data.document);
        return;
      }
      setError(errorMessage(res.data, res.status));
      return;
    }
    const saved = (res.data as { document: KnowledgeDocDetailDto }).document;
    setCreating(false);
    setSelectedId(saved.id);
    setDetail(saved);
    setForm(formFrom(saved));
    setNotice(creating ? '已创建（已核验）' : '已保存（已核验）');
    void load();
  }

  async function setVerified(verified: boolean): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    const res = await api.verifyKnowledgeDoc(workspaceId, selectedId, verified);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice(verified ? '已标记为人工核验' : '已取消核验');
    const doc = (res.data as { document: KnowledgeDocDto }).document;
    void open(doc);
    void load();
  }

  async function remove(): Promise<void> {
    if (!selectedId) return;
    if (!window.confirm(`删除「${form.title || detail?.title || '这篇知识'}」？此操作不可恢复。`)) return;
    setBusy(true);
    const res = await api.deleteKnowledgeDoc(workspaceId, selectedId);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setSelectedId(null);
    setDetail(null);
    setForm(EMPTY_FORM);
    setNotice('已永久删除');
    void load();
  }

  async function doExport(): Promise<void> {
    setBusy(true);
    const res = await exportKnowledge(
      workspaceId,
      `${workspaceName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'workspace'}-knowledge.zip`,
    );
    setBusy(false);
    if (res.ok) setNotice(`已导出到 ${res.path}`);
    else if (res.code !== 'canceled') setError(res.message);
  }

  const editing = creating || detail !== null;
  const initialLoading = loading && !loadedOnce;
  const emptyTitle = initialLoading
    ? '加载中…'
    : documents.length === 0
      ? filter === 'all'
        ? '还没有知识文档'
        : '没有匹配的知识'
      : '选择一篇知识';
  const emptyHint = documents.length === 0
    ? filter === 'all'
      ? '把 Markdown 放进知识目录会自动收录；也可以直接新建一篇。'
      : '当前筛选没有文档，换个筛选或新建一篇。'
    : '从左侧选择一篇查看、编辑和核验。';

  return (
    <div
      className="kn-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="工作区知识"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="kn-panel">
        <header className="kn-head">
          <div className="kn-head-copy">
            <div className="kn-head-title">
              <h2>知识</h2>
              <span className="kn-workspace-chip">{workspaceName}</span>
            </div>
            <p className="hint">
              文件自动收录，按指针注入；规范/知识/需求可按需新建，未核验条目可人工核验。
            </p>
          </div>
          <div className="kn-head-actions">
            <button className="btn primary" onClick={openCreateMenu} disabled={busy}>
              <Icon name="plus" size={14} />
              新建
            </button>
            <button className="btn" onClick={() => void doExport()} disabled={busy}>
              导出 ZIP
            </button>
            <button className="icon-btn kn-close" title="关闭" aria-label="关闭" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>
        <div className="kn-body">
          <aside className="kn-list">
            <div className="kn-sidebar-head">
              <span className="kn-sidebar-title">知识文档</span>
              <span className="kn-sidebar-count">{documents.length}</span>
            </div>
            <div className="kn-tabs">
              {FILTERS.map((tab) => (
                <button
                  key={tab.id}
                  className={`kn-tab${filter === tab.id ? ' is-active' : ''}`}
                  onClick={() => setFilter(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="kn-search-wrap">
              <Icon name="search" size={14} />
              <input
                className="kn-search"
                placeholder="搜索标题、摘要、标签、正文"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="kn-items">
              {initialLoading ? (
                <p className="kn-list-hint">加载中…</p>
              ) : documents.length === 0 ? (
                <div className="kn-list-empty">
                  <Icon name="folder" size={18} />
                  <span>{filter === 'all' ? '暂无知识' : '没有匹配的知识'}</span>
                  <span className="hint">放到知识目录会自动收录</span>
                </div>
              ) : (
                documents.map((doc) => (
                  <button
                    key={doc.id}
                    className={`kn-item${selectedId === doc.id ? ' is-active' : ''}`}
                    onClick={() => void open(doc)}
                  >
                    <span className="kn-item-title">{doc.title}</span>
                    <span className="kn-item-meta">
                      <span
                        className={`kn-status ${
                          doc.reviewStatus === 'missing'
                            ? 'missing'
                            : isVerified(doc)
                              ? 'verified'
                              : 'unverified'
                        }`}
                      >
                        {doc.reviewStatus === 'missing' ? '文件缺失' : isVerified(doc) ? '已核验' : '未核验'}
                      </span>
                      <span>{KINDS.find((kind) => kind.id === doc.kind)?.label ?? doc.kind}</span>
                      {doc.endId && <span>· {doc.endId}</span>}
                    </span>
                    <span className="kn-item-path mono">{doc.path}</span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="kn-detail">
            {!editing ? (
              <div className="kn-empty">
                <div className="kn-empty-icon">
                  <Icon name={documents.length === 0 ? 'folder' : 'file'} size={26} />
                </div>
                <h3>{emptyTitle}</h3>
                <p className="hint">{emptyHint}</p>
                <div className="kn-empty-actions">
                  <button className="btn primary" onClick={openCreateMenu} disabled={busy}>
                    <Icon name="plus" size={14} />
                    新建
                  </button>
                  <button className="btn" onClick={() => void doExport()} disabled={busy}>
                    导出 ZIP
                  </button>
                </div>
                <div className="kn-empty-steps">
                  <span>自动收录</span>
                  <span>指针注入</span>
                  <span>未核验标注</span>
                </div>
              </div>
            ) : (
              <>
                <div className="kn-detail-head">
                  <h3>{creating ? '新建文档' : '编辑文档'}</h3>
                  {detail && (
                    <span
                      className={`kn-status ${
                        detail.reviewStatus === 'missing'
                          ? 'missing'
                          : isVerified(detail)
                            ? 'verified'
                            : 'unverified'
                      }`}
                    >
                      {detail.reviewStatus === 'missing'
                        ? '文件缺失'
                        : isVerified(detail)
                          ? '已核验'
                          : '未核验'}
                    </span>
                  )}
                </div>
                <div className="kn-fields">
                  <label>
                    <span>标题</span>
                    <input
                      value={form.title}
                      onChange={(event) => setForm({ ...form, title: event.target.value })}
                      disabled={busy}
                    />
                  </label>
                  {(!creating || customKind) && (
                    <label>
                      <span>类型</span>
                      <select
                        value={form.kind}
                        onChange={(event) =>
                          setForm({ ...form, kind: event.target.value as KnowledgeDocumentKind })
                        }
                        disabled={busy}
                      >
                        {(creating
                          ? KINDS.filter((kind) => kind.id !== 'workspace_context')
                          : KINDS
                        ).map((kind) => (
                          <option key={kind.id} value={kind.id}>
                            {kind.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <label className="kn-summary">
                  <span>摘要（留空自动取第一段）</span>
                  <input
                    value={form.summary}
                    onChange={(event) => setForm({ ...form, summary: event.target.value })}
                    disabled={busy}
                  />
                </label>
                {detail && (
                  <div className="kn-meta mono">
                    <span>{detail.path}</span>
                    <span>
                      {isVerified(detail) ? '已核验' : '未核验'} · {detail.lastEditedBy} ·{' '}
                      {detail.contentHash.slice(0, 19)}…
                    </span>
                  </div>
                )}
                {detail && !isVerified(detail) && (
                  <div className="kn-warn">
                    未核验：这条知识是自动收录的，会被注入但会带「未核验」标记；建议看一眼再人工核验。
                  </div>
                )}
                <textarea
                  className="kn-editor mono"
                  value={form.body}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <div className="kn-actions">
                  <button className="btn primary" onClick={() => void save()} disabled={busy}>
                    {creating ? '创建（已核验）' : '保存（已核验）'}
                  </button>
                  {detail && (
                    <button className="btn" onClick={() => void setVerified(!isVerified(detail))} disabled={busy}>
                      {isVerified(detail) ? '取消核验' : '标记已核验'}
                    </button>
                  )}
                  {detail && (
                    <button className="btn danger" onClick={() => void remove()} disabled={busy}>
                      删除
                    </button>
                  )}
                  <span className="kn-hint-inline">
                    知识更新只对新会话生效；已注入文档的正文更新在 agent 读取路径时自然生效。
                  </span>
                </div>
              </>
            )}
            {error && <div className="kn-error">{error}</div>}
          </section>
        </div>
        {showCreateMenu && (
          <div
            className="kn-create-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="新建文档"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowCreateMenu(false);
            }}
          >
            <div className="kn-create-dialog">
              <h3>新建文档</h3>
              <p className="hint">先选一个常用类型，或完全自定义。</p>
              <div className="kn-create-options">
                <button
                  type="button"
                  className="btn kn-create-option"
                  onClick={() => void startWithPreset('convention')}
                >
                  <strong>规范文档</strong>
                  <span>全工作区一份，写硬规矩与约束</span>
                </button>
                <button
                  type="button"
                  className="btn kn-create-option"
                  onClick={() => void startWithPreset('note')}
                >
                  <strong>知识</strong>
                  <span>知识目录下的普通文档</span>
                </button>
                <button
                  type="button"
                  className="btn kn-create-option"
                  onClick={() => void startWithPreset('requirement')}
                >
                  <strong>需求</strong>
                  <span>需求目录下的文档</span>
                </button>
                <button
                  type="button"
                  className="btn kn-create-option"
                  onClick={() => startCreate('note', { custom: true })}
                >
                  <strong>自定义</strong>
                  <span>类型、标题和内容全部自己填</span>
                </button>
              </div>
              <div className="kn-create-actions">
                <button className="btn" onClick={() => setShowCreateMenu(false)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
        {notice && <div className="ws-notice kn-notice">{notice}</div>}
      </div>
    </div>
  );
}
