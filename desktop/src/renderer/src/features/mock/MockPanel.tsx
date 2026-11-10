import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import type { MockApiDto, MockModelDto } from '../../../../shared/contract';
import { Icon } from '../../ui/Icon';

interface Props {
  workspaceId: string;
  workspaceName: string;
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

function nextApiId(model: MockModelDto): string {
  let index = 1;
  while (model.apis.some((item) => item.id === `api-${index}`)) index += 1;
  return `api-${index}`;
}

export function MockPanel({ workspaceId, workspaceName, onClose }: Props) {
  const [model, setModel] = useState<MockModelDto>({ apis: [], rules: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [rules, setRules] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    const load = async (initial: boolean): Promise<void> => {
      const res = await api.workspaceMock(workspaceId);
      if (cancelled) return;
      if (!res.ok) {
        setError(errorMessage(res.data, res.status));
        return;
      }
      const next = res.data.model;
      setModel(next);
      if (!initial && dirtyRef.current) return;
      setRules(next.rules);
      const id = next.apis.some((item) => item.id === selectedRef.current)
        ? selectedRef.current
        : (next.apis[0]?.id ?? null);
      setSelectedId(id);
      const selected = next.apis.find((item) => item.id === id);
      setDraft(selected ? JSON.stringify(selected, null, 2) : '');
      setDirty(false);
      setError(null);
    };
    void load(true);
    const timer = setInterval(() => {
      void load(false);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId]);

  function selectApi(item: MockApiDto): void {
    setSelectedId(item.id);
    setDraft(JSON.stringify(item, null, 2));
    setDirty(false);
  }

  function addApi(): void {
    const id = nextApiId(model);
    const item: MockApiDto = { id, method: 'GET', path: '/path' };
    setModel((current) => ({ ...current, apis: [...current.apis, item] }));
    setSelectedId(id);
    setDraft(JSON.stringify(item, null, 2));
    setDirty(false);
  }

  async function deleteApi(): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    const apis = model.apis.filter((item) => item.id !== selectedId);
    const res = await api.saveWorkspaceMock(workspaceId, { apis, rules }, [selectedId]);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice(`已删除 ${selectedId}`);
    setModel(res.data.model);
    setSelectedId(res.data.model.apis[0]?.id ?? null);
    setDraft(
      res.data.model.apis[0] ? JSON.stringify(res.data.model.apis[0], null, 2) : '',
    );
    setDirty(false);
  }

  async function save(): Promise<void> {
    let parsed: MockApiDto;
    try {
      parsed = JSON.parse(draft) as MockApiDto;
    } catch {
      setError('接口 JSON 解析失败');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || !parsed.id) {
      setError('接口必须有字符串 id');
      return;
    }
    const apis = model.apis.some((item) => item.id === parsed.id)
      ? model.apis.map((item) => (item.id === parsed.id ? parsed : item))
      : [...model.apis, parsed];
    const remove = selectedId && selectedId !== parsed.id ? [selectedId] : [];
    setBusy(true);
    setError(null);
    const res = await api.saveWorkspaceMock(workspaceId, { apis, rules }, remove);
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data, res.status));
      return;
    }
    setNotice('Mock 已保存');
    setModel(res.data.model);
    setSelectedId(parsed.id);
    setDirty(false);
  }

  return (
    <div
      className="kn-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Mock API"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
    <div className="kn-panel mock-panel">
      <header className="kn-head">
        <div className="kn-head-copy">
          <div className="kn-head-title">
            <Icon name="file" size={16} />
            <h2>Mock API</h2>
            <span className="badge subtle">{workspaceName}</span>
          </div>
          <p className="hint">
            文件即 fixture：agent 直接改 <code>mock/apis/*.json</code>，面板每 3 秒刷新；
            编辑后保存即写回文件。
          </p>
        </div>
        <div className="kn-head-actions">
          <button className="icon-btn kn-close" title="关闭" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="mock-body">
        <aside className="mock-list">
          {model.apis.map((item) => (
            <button
              key={item.id}
              className={`mem-row${selectedId === item.id ? ' is-active' : ''}`}
              onClick={() => selectApi(item)}
            >
              <span className="mem-row-summary mono">{item.id}</span>
              <span className="mem-row-meta">
                <span className="mem-tag">{String(item.method ?? 'GET')}</span>
                <span className="mem-row-date">{String(item.path ?? '')}</span>
              </span>
            </button>
          ))}
          <button className="btn" onClick={addApi} disabled={busy}>
            <Icon name="plus" size={14} />
            新建接口
          </button>
        </aside>

        <section className="mock-editor">
          <div className="section-head">
            <h3>{selectedId ?? '接口'}</h3>
            <span className="mem-spacer" />
            <button className="btn" disabled={busy || !selectedId} onClick={() => void deleteApi()}>
              删除
            </button>
            <button className="btn primary" disabled={busy || !draft} onClick={() => void save()}>
              保存
            </button>
          </div>
          <textarea
            className="mock-textarea"
            value={draft}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
            }}
            placeholder='{ "id": "user.list", "method": "GET", "path": "/users", "baseline": { "status": 200 } }'
          />
          <div className="section-head">
            <h3>规则 rules.yaml</h3>
          </div>
          <textarea
            className="mock-textarea rules"
            value={rules}
            spellCheck={false}
            onChange={(event) => {
              setRules(event.target.value);
              setDirty(true);
            }}
            placeholder={'user.list: empty'}
          />
          {error && <p className="mem-error">{error}</p>}
          {notice && <p className="hint">{notice}</p>}
        </section>
      </div>
    </div>
    </div>
  );
}
