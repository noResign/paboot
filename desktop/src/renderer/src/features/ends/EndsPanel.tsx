import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import type {
  EndDto,
  EndImpactDto,
  KnowledgeDocDto,
} from '../../../../shared/contract';
import { Icon } from '../../ui/Icon';
import { DirectoryPickerDialog } from '../workspaces/DirectoryPickerDialog';
import { impactLines } from './endLifecycle';

interface Props {
  workspaceId: string;
  workspaceName: string;
  /** Open directly on an end (clicked from the workspace overview). */
  initialEndId?: string | null;
  /** Opened from the overview's「添加端」entry; auto-open the create dialog. */
  startAdding?: boolean;
  onClose(): void;
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; message?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message;
    if (typeof record.error === 'string' && record.error) return record.error;
  }
  return `请求失败（HTTP ${status}）`;
}

export function EndsPanel({ workspaceId, workspaceName, initialEndId, startAdding, onClose }: Props) {
  const [ends, setEnds] = useState<EndDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rootPicker, setRootPicker] = useState(false);
  const [addDirPicker, setAddDirPicker] = useState(false);
  // Seeded from the prop, not from an effect: opening from「添加端」must not paint
  // the first end's detail behind the dialog even for one frame.
  const [addOpen, setAddOpen] = useState(startAdding === true);
  // No「领域」field: `kind` stays in the record for future capability routing, but
  // it no longer asks the user anything — see the note on `addEnd`.
  const [addName, setAddName] = useState('');
  const [addSummary, setAddSummary] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addDir, setAddDir] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [notes, setNotes] = useState('');
  const [docs, setDocs] = useState<KnowledgeDocDto[]>([]);
  const [docTitle, setDocTitle] = useState('');
  const [docBody, setDocBody] = useState('');
  const [editingDoc, setEditingDoc] = useState<string | null>(null);
  const [pending, setPending] = useState<{ kind: 'archive' | 'delete'; end: EndDto } | null>(null);
  const [impact, setImpact] = useState<EndImpactDto | null>(null);
  const [docFormOpen, setDocFormOpen] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  const selected = ends.find((end) => end.id === selectedId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.workspaceEnds(workspaceId);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      setLoading(false);
      return;
    }
    setEnds(res.data.ends);
    setLoading(false);
  }, [workspaceId]);

  const loadKnowledge = useCallback(
    async (endId: string) => {
      const res = await api.knowledge(workspaceId, { endId, kind: 'convention' });
      if (res.ok) setDocs(res.data.documents);
    },
    [workspaceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (initialEndId) setSelectedId(initialEndId);
  }, [initialEndId]);

  useEffect(() => {
    if (startAdding) setAddOpen(true);
  }, [startAdding]);

  // No auto-select. It used to jump to the first end whenever nothing was
  // selected, which made「取消」look like it created an android end: the panel
  // filled itself with the first end's detail. An unselected panel shows the end
  // list instead, so "nothing chosen" is a state the user can actually see.

  useEffect(() => {
    if (!selected) {
      setSummary('');
      setNotes('');
      setDocs([]);
      return;
    }
    setSummary(selected.summary);
    setNotes(selected.notes);
    void loadKnowledge(selected.id);
  }, [selected, loadKnowledge]);

  /**
   * Open the create form with nothing selected behind it. Keeping the previous
   * end's detail on screen made the form look like it belonged to that end.
   */
  function openAdd(): void {
    setSelectedId(null);
    setAddName('');
    setAddSummary('');
    setAddNotes('');
    setAddDir(null);
    setAddOpen(true);
  }

  async function addEnd(): Promise<void> {
    const name = addName.trim();
    if (!name) {
      setError('先填写端名称');
      return;
    }
    if (!addDir) {
      setError('先选择端目录');
      return;
    }
    setBusy(true);
    setError(null);
    // `kind` is deliberately not sent: it only ever picked which conventions got
    // seeded, and asking for it made users think it did more than that. The daemon
    // keeps the column (unknown → `generic`, seeds nothing) so capability routing
    // can use it later without another migration.
    const created = await api.createWorkspaceEnd(workspaceId, name, {
      summary: addSummary.trim(),
      notes: addNotes.trim(),
    });
    if (!created.ok) {
      setError(errorMessage(created.data, created.status));
      setBusy(false);
      return;
    }
    const endId = created.data.end.id;
    const bound = await api.bindEndRoot(workspaceId, endId, addDir);
    if (!bound.ok) {
      setError(errorMessage(bound.data, bound.status));
      setBusy(false);
      return;
    }
    const activated = await api.activateEnd(workspaceId, endId);
    setBusy(false);
    if (!activated.ok) {
      setError(errorMessage(activated.data, activated.status));
      return;
    }
    setAddOpen(false);
    setAddDir(null);
    setAddName('');
    setAddSummary('');
    setAddNotes('');
    // Select the new end before the list reloads, so the panel lands on it
    // instead of briefly showing the (now stale) list.
    setSelectedId(endId);
    setNotice('端已添加');
    await load();
  }

  async function saveText(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    const res = await api.updateEnd(workspaceId, selected.id, { summary, notes });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice('已保存端描述');
    await load();
  }

  async function openImpact(kind: 'archive' | 'delete', end: EndDto): Promise<void> {
    setPending({ kind, end });
    setImpact(null);
    const res = await api.endImpact(workspaceId, end.id);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      setPending(null);
      return;
    }
    setImpact(res.data.impact);
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    const res =
      pending.kind === 'archive'
        ? await api.archiveEnd(workspaceId, pending.end.id)
        : await api.deleteWorkspaceEnd(workspaceId, pending.end.id);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice(pending.kind === 'archive' ? '端已归档' : '端已移除');
    setPending(null);
    setImpact(null);
    await load();
  }

  async function restore(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    const res = await api.restoreEnd(workspaceId, selected.id);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice('端已恢复');
    await load();
  }

  async function saveDoc(): Promise<void> {
    if (!selected || !docTitle.trim()) return;
    setBusy(true);
    const res = editingDoc
      ? await api.updateKnowledgeDoc(workspaceId, editingDoc, { title: docTitle, body: docBody })
      : await api.createKnowledgeDoc(workspaceId, {
          title: docTitle,
          body: docBody,
          kind: 'convention',
          endId: selected.id,
        });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setDocTitle('');
    setDocBody('');
    setEditingDoc(null);
    setNotice('规范已保存');
    await loadKnowledge(selected.id);
  }

  async function removeDoc(doc: KnowledgeDocDto): Promise<void> {
    if (!window.confirm(`删除规范「${doc.title}」？`)) return;
    const res = await api.deleteKnowledgeDoc(workspaceId, doc.id);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    if (selected) await loadKnowledge(selected.id);
  }

  async function editDoc(doc: KnowledgeDocDto): Promise<void> {
    const res = await api.knowledgeDoc(workspaceId, doc.id);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setEditingDoc(doc.id);
    setDocTitle(res.data.document.title);
    setDocBody(res.data.document.body);
  }

  const detailOpen = Boolean(selected) || addOpen;

  return (
    <div
      className="kn-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="端管理"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="kn-panel ends-panel">
        {detailOpen ? (
          // A selected end (or the create view) owns the whole panel: the
          // workspace-level head would just be noise above it.
          <div className="ends-mini-head">
            <button
              className="btn ghost"
              onClick={() => {
                if (addOpen) setAddOpen(false);
                else setSelectedId(null);
              }}
            >
              <Icon name="arrow-left" size={15} />
              返回端列表
            </button>
            <button className="icon-btn kn-close" title="关闭" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        ) : (
          <header className="kn-head">
            <div className="kn-head-copy">
              <div className="kn-head-title">
                <Icon name="folder" size={16} />
                <h2>端</h2>
                <span className="badge subtle">{workspaceName}</span>
              </div>
              <p className="hint">先加端（名称 + 目录），再维护端规范与知识。</p>
            </div>
            <div className="kn-head-actions">
              {/* Same intent as the overview's「添加端」entry. Without it, cancelling
                  left the panel with no way back to it. */}
              <button className="btn tiny" onClick={openAdd} disabled={addOpen}>
                添加端
              </button>
              <button className="icon-btn" title="刷新" onClick={() => void load()}>
                <Icon name="refresh" size={16} />
              </button>
              <button className="icon-btn kn-close" title="关闭" onClick={onClose}>
                <Icon name="x" size={16} />
              </button>
            </div>
          </header>
        )}

        <div className="ends-body">
          {loading && <p className="hint">加载中…</p>}

          {/* Creating is a view *inside* this panel, not a modal on top of it: the
              panel is already an overlay, so a nested dialog read as two stacked
              popups. The form replaces the detail pane until it is done or cancelled. */}
          {addOpen && (
            <div className="end-detail">
              <div className="section-head">
                <h3>添加端</h3>
                <span className="hint">命名 → 描述 → 挂目录 → 创建并激活</span>
              </div>
              <label className="field">
                <span>名称</span>
                <input
                  autoFocus
                  value={addName}
                  maxLength={80}
                  placeholder="例如 Android、Web、文档站"
                  onChange={(event) => setAddName(event.target.value)}
                />
              </label>
              {/* Same two fields as the detail pane: the create request already
                  accepts them, so describing an end afterwards was busywork. */}
              <label className="field">
                <span>一句话描述</span>
                <input
                  value={addSummary}
                  maxLength={200}
                  placeholder="这个端是什么，例如「Android 客户端」"
                  onChange={(event) => setAddSummary(event.target.value)}
                />
              </label>
              <label className="field">
                <span>注意事项</span>
                <textarea
                  rows={3}
                  value={addNotes}
                  maxLength={4000}
                  placeholder="给自己的提醒，例如「不要改 versionCode 规则」"
                  onChange={(event) => setAddNotes(event.target.value)}
                />
              </label>
              <div className="device-root-row">
                <span className="mono device-root">{addDir ?? '未选择目录'}</span>
                <button className="btn" onClick={() => setAddDirPicker(true)}>选择目录</button>
              </div>
              <p className="hint">
                目录需位于主工作区或已添加的附加目录内。规范在端详情里写。
              </p>
              <div className="perm-actions">
                <button
                  className="btn primary"
                  disabled={busy || !addDir || !addName.trim()}
                  onClick={() => void addEnd()}
                >
                  创建并激活
                </button>
                <button className="btn" onClick={() => setAddOpen(false)}>取消</button>
              </div>
            </div>
          )}

          {/* Unselected and not creating: the end list. Cancelling lands here
              instead of silently jumping into whichever end is first. */}
          {!loading && !selected && !addOpen && (
            ends.length === 0 ? (
              <p className="hint">
                这个工作区还没有端。先添加一个端（名称 + 目录），再维护端规范与知识。
              </p>
            ) : (
              <>
                <p className="hint">选择一个端查看它的目录、规范与生命周期。</p>
                <div className="ends-list">
                  {ends.map((end) => (
                    <button
                      key={end.id}
                      type="button"
                      className="wo-knowledge"
                      onClick={() => setSelectedId(end.id)}
                    >
                      <span className="wo-knowledge-icon"><Icon name="folder" size={18} /></span>
                      <span className="wo-knowledge-copy">
                        <b>{end.name}</b>
                        <span className="hint">
                          {end.roots.length} 个目录
                          {end.summary ? ` · ${end.summary}` : ''}
                        </span>
                      </span>
                      <span className="wo-knowledge-action">
                        {end.status === 'active' ? '已启用' : '已归档'}
                        <Icon name="chevron-right" size={14} />
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )
          )}

          {selected && (
            <div className="end-detail">
              <div className="section-head">
                <h3>{selected.name}</h3>
                <span className="hint">{selected.status === 'active' ? '已启用' : '已归档'}</span>
              </div>

              <label className="field">
                <span>一句话描述</span>
                <input
                  value={summary}
                  maxLength={200}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </label>
              <label className="field">
                <span>注意事项</span>
                <textarea
                  rows={4}
                  value={notes}
                  maxLength={4000}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
              <div className="perm-actions">
                <button className="btn primary" disabled={busy} onClick={() => void saveText()}>
                  保存描述
                </button>
              </div>

              <div className="section-head"><h3>目录</h3></div>
              {selected.roots.map((root) => (
                <div className="device-root-row" key={root}>
                  <span className="mono device-root" title={root}>{root}</span>
                  <button
                    className="icon-btn"
                    title="移除目录"
                    disabled={busy}
                    onClick={async () => {
                      const res = await api.unbindEndRoot(workspaceId, selected.id, root);
                      if (res.ok) await load();
                      else setError(errorMessage(res.data, res.status));
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              <button className="btn" disabled={busy} onClick={() => setRootPicker(true)}>
                添加目录
              </button>

              <div className="section-head">
                <h3>端规范与知识</h3>
                <span className="hint">知识文档，按指针注入；上面的描述 / 注意事项是端级补充</span>
                <button
                  className="btn"
                  onClick={() => {
                    setDocFormOpen((open) => !open);
                    if (docFormOpen) {
                      setDocTitle('');
                      setDocBody('');
                      setEditingDoc(null);
                    }
                  }}
                >
                  {docFormOpen ? '收起' : '新增规范'}
                </button>
              </div>
              {docs.map((doc) => (
                <div className="device-root-row" key={doc.id}>
                  <span className="device-root">{doc.title}</span>
                  <button className="btn" onClick={() => void editDoc(doc)}>编辑</button>
                  <button className="btn" onClick={() => void removeDoc(doc)}>删除</button>
                </div>
              ))}
              {(docFormOpen || editingDoc) && (
              <>
              <label className="field">
                <span>{editingDoc ? '编辑规范' : '新增规范'}</span>
                <input
                  placeholder="标题"
                  value={docTitle}
                  onChange={(event) => setDocTitle(event.target.value)}
                />
                <textarea
                  rows={4}
                  placeholder="正文"
                  value={docBody}
                  onChange={(event) => setDocBody(event.target.value)}
                />
              </label>
              <div className="perm-actions">
                <button className="btn primary" disabled={busy || !docTitle.trim()} onClick={() => void saveDoc()}>
                  {editingDoc ? '保存规范' : '添加规范'}
                </button>
                {editingDoc && (
                  <button
                    className="btn"
                    onClick={() => {
                      setEditingDoc(null);
                      setDocTitle('');
                      setDocBody('');
                    }}
                  >
                    取消编辑
                  </button>
                )}
              </div>
              </>
              )}

              <div className="section-head"><h3>生命周期</h3></div>
              <div className="perm-actions">
                {selected.status === 'active' ? (
                  <button className="btn" disabled={busy} onClick={() => void openImpact('archive', selected)}>
                    归档端
                  </button>
                ) : (
                  <button className="btn" disabled={busy} onClick={() => void restore()}>
                    恢复端
                  </button>
                )}
                <button
                  className="btn danger"
                  disabled={busy || selected.status === 'active'}
                  title={selected.status === 'active' ? '请先归档端再移除' : undefined}
                  onClick={() => void openImpact('delete', selected)}
                >
                  移除端
                </button>
              </div>
            </div>
          )}

          {error && <p className="mem-error">{error}</p>}
          {notice && <p className="hint">{notice}</p>}
        </div>
      </div>

      {pending && (
        <div className="modal-scrim" onClick={() => setPending(null)}>
          <div className="modal end-impact-modal" role="dialog" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>{pending.kind === 'archive' ? `归档端「${pending.end.name}」？` : `移除端「${pending.end.name}」？`}</span>
              <button className="btn ghost" onClick={() => setPending(null)}>
                <Icon name="x" size={15} />
              </button>
            </div>
            {impact ? (
              <ul className="end-impact-list">
                {impactLines(impact).map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : (
              <p className="hint">正在计算影响…</p>
            )}
            <p className="hint">
              {pending.kind === 'archive'
                ? '归档后停止端上下文与知识注入，可随时恢复。'
                : '移除会删除端目录绑定与端知识；会话保留。'}
            </p>
            <div className="perm-actions">
              <button className="btn danger" disabled={busy || !impact} onClick={() => void confirmPending()}>
                {pending.kind === 'archive' ? '归档' : '移除'}
              </button>
              <button className="btn" onClick={() => setPending(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {rootPicker && selected && (
        <DirectoryPickerDialog
          mode="end-root"
          workspacePaths={[]}
          busy={busy}
          error={error}
          onClose={() => setRootPicker(false)}
          onPick={(picked) => {
            setRootPicker(false);
            void (async () => {
              const res = await api.bindEndRoot(workspaceId, selected.id, picked);
              if (res.ok) await load();
              else setError(errorMessage(res.data, res.status));
            })();
          }}
        />
      )}

      {addDirPicker && (
        <DirectoryPickerDialog
          mode="end-root"
          workspacePaths={[]}
          busy={busy}
          error={error}
          onClose={() => setAddDirPicker(false)}
          onPick={(picked) => {
            setAddDir(picked);
            setAddDirPicker(false);
          }}
        />
      )}

    </div>
  );
}
