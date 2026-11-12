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

const KINDS = ['android', 'ios', 'web', 'api', 'data', 'test'] as const;

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
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<string>('android');
  const [addName, setAddName] = useState('android');
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

  useEffect(() => {
    if (!selectedId && ends.length > 0) setSelectedId(ends[0]!.id);
  }, [ends, selectedId]);

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

  async function addEnd(): Promise<void> {
    if (!addDir) {
      setError('先选择端目录');
      return;
    }
    setBusy(true);
    setError(null);
    const created = await api.createWorkspaceEnd(
      workspaceId,
      addName.trim() || addKind,
      addKind,
    );
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
    setNotice('端已添加');
    await load();
    setSelectedId(endId);
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
        <header className="kn-head">
          <div className="kn-head-copy">
            <div className="kn-head-title">
              <Icon name="folder" size={16} />
              <h2>端</h2>
              <span className="badge subtle">{workspaceName}</span>
            </div>
            <p className="hint">先加端（领域 + 目录），再维护端规范与知识。</p>
          </div>
          <div className="kn-head-actions">
            <button className="icon-btn" title="刷新" onClick={() => void load()}>
              <Icon name="refresh" size={16} />
            </button>
            <button className="icon-btn kn-close" title="关闭" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="ends-body">
          {loading && <p className="hint">加载中…</p>}

          {selected && (
            <div className="end-detail">
              <div className="section-head">
                <h3>{selected.name}</h3>
                <span className="badge subtle">{selected.kind}</span>
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

      {addOpen && (
        <div className="modal-scrim" onClick={() => setAddOpen(false)}>
          <div className="modal end-impact-modal" role="dialog" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>添加端</span>
              <button className="btn ghost" onClick={() => setAddOpen(false)}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <label className="field">
              <span>领域</span>
              <select
                className="mem-select"
                value={addKind}
                onChange={(event) => {
                  setAddKind(event.target.value);
                  setAddName(event.target.value);
                }}
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>{kind}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>名称</span>
              <input value={addName} onChange={(event) => setAddName(event.target.value)} />
            </label>
            <div className="device-root-row">
              <span className="mono device-root">{addDir ?? '未选择目录'}</span>
              <button className="btn" onClick={() => setAddDirPicker(true)}>选择目录</button>
            </div>
            <p className="hint">目录需位于主工作区或已添加的附加目录内；激活后会种入领域默认规范。</p>
            <div className="perm-actions">
              <button className="btn primary" disabled={busy || !addDir} onClick={() => void addEnd()}>
                创建并激活
              </button>
              <button className="btn" onClick={() => setAddOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

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
