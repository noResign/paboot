import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import type { DirectoriesResponse } from '../../../../shared/contract';

interface Props {
  /**
   * `create` → the picked dir becomes a new workspace; `add-dir` → an extra dir on
   * an existing one; `shortcut` → a files-tab bookmark (browsing only, grants the
   * agent nothing).
   */
  mode: 'create' | 'add-dir' | 'shortcut';
  /** Canonical paths of existing workspaces, so the current dir can be tagged/turned off. */
  workspacePaths: string[];
  busy: boolean;
  /** The caller's create/add failure: shown here, next to the input, so the dialog stays open. */
  error: string | null;
  onClose(): void;
  onPick(path: string): void;
}

/**
 * The one directory browser, reused by「新增工作区」and「添加附加目录」— and, in
 * M4, by「启动本机 daemon」的 `--workspace`. Folders only, folders first; the
 * desktop-only affordance is that an absolute path can be typed and Enter-jumped
 * (`docs/local/pages/settings.md` §6.9 ⑨).
 *
 * Browsing is deliberately unrestricted: the workspace is not a sandbox, and the
 * token holder owns the machine (daemon.md §9).
 */
export function DirectoryPickerDialog({ mode, workspacePaths, busy, error, onClose, onPick }: Props) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [listing, setListing] = useState<DirectoriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void api.directories(cwd ?? undefined, showHidden).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        // Keep the last good listing on screen: a typo in the path box should
        // not blank the browser, only explain itself.
        const { apiCode, message } = apiErrorOf(res.data);
        setLoadError(friendlyMessage(apiCode, res.status, message, '无法打开该目录'));
        return;
      }
      setListing(res.data);
      setInput(res.data.path);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, showHidden]);

  const isWorkspace = listing !== null && workspacePaths.includes(listing.path);
  const confirmDisabled = busy || listing === null || (mode === 'create' && isWorkspace);
  const title = mode === 'create' ? '选择工作区目录' : mode === 'add-dir' ? '选择附加目录' : '选择要浏览的目录';
  const confirmLabel =
    mode === 'create' ? (isWorkspace ? '已是工作区' : '选择当前文件夹') : '添加此文件夹';

  function jump(): void {
    const next = input.trim();
    if (!next) return;
    setCwd(next);
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal dir-picker" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="dir-path-row">
          <input
            className="mono dir-path-input"
            value={input}
            spellCheck={false}
            placeholder="输入绝对路径后回车"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                jump();
              }
            }}
          />
          <button className="btn ghost" disabled={!listing?.parent} onClick={() => listing?.parent && setCwd(listing.parent)}>
            上一级
          </button>
          <button className="btn ghost" onClick={() => setShowHidden((value) => !value)}>
            {showHidden ? '隐藏隐藏目录' : '显示隐藏目录'}
          </button>
        </div>

        <div className="dir-list">
          {loading && <div className="hint">加载中…</div>}
          {!loading && listing && listing.entries.length === 0 && <div className="hint">这个目录下没有子文件夹。</div>}
          {listing?.entries.map((entry) => (
            <button key={entry.path} className="dir-entry" onClick={() => setCwd(entry.path)}>
              <span className="dir-entry-name">📁 {entry.name}</span>
              {entry.isWorkspace && <span className="hint">已是工作区</span>}
            </button>
          ))}
        </div>

        <div className="hint">
          {mode === 'shortcut'
            ? '只是文件栏的一个浏览入口，不改变 agent 的读写范围。'
            : '工作区不是沙箱：agent 仍能读工作区外的东西，写则只在这个目录（及其附加目录）内。'}
        </div>
        {(loadError ?? error) && <div className="error-text">{loadError ?? error}</div>}

        <div className="perm-actions">
          <button className="btn primary" disabled={confirmDisabled} onClick={() => listing && onPick(listing.path)}>
            {busy ? '处理中…' : confirmLabel}
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
