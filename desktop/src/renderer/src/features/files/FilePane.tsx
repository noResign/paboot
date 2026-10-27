import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import { formatBytes } from '../../../../shared/format';
import { Icon } from '../../ui/Icon';
import { DiffViewer, type DiffView } from './DiffViewer';
import { FileContent } from './FileContent';
import { directoryLabel, fileName } from './pathLabel';
import type { FileSelection } from './FileBrowser';
import type { ChangeStatus, DiffResponse, FileContentDto } from '../../../../shared/contract';

interface Props {
  workspaceId: string | null;
  root: string | null;
  selection: FileSelection | null;
  view: DiffView;
  onViewChange(view: DiffView): void;
  /**
   * Close the viewer and return to the list. In drill-down that restores the
   * full-width list; in split it collapses the directory column back to it.
   */
  onBack?: () => void;
  onClose?: () => void;
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
};

/**
 * The content half: header (path / status / diff counts / view mode) plus the
 * diff or text viewer. Used by the chat's right panel.
 *
 * The header carries the panel's close and back affordances, so the panel
 * itself needs no separate title bar.
 */
export function FilePane({
  workspaceId,
  root,
  selection,
  view,
  onViewChange,
  onBack,
  onClose,
}: Props) {
  const [file, setFile] = useState<FileContentDto | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Clear first, even when there is nothing to load: a deselected file — or a
    // workspace switch — must not leave the previous file on screen.
    setFile(null);
    setDiff(null);
    setError(null);
    if (!workspaceId || !selection) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const query = { workspaceId, root: root ?? undefined, path: selection.path };
    void (selection.kind === 'diff' ? api.changesDiff(query) : api.fileContent(query)).then((res) => {
      if (!live) return;
      setLoading(false);
      if (!res.ok) {
        const { apiCode, message } = apiErrorOf(res.data);
        setError(friendlyMessage(apiCode, res.status, message, '读取失败'));
        return;
      }
      if (selection.kind === 'diff') setDiff(res.data as DiffResponse);
      else setFile(res.data as FileContentDto);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, root, selection]);

  const stats = diff && !diff.binary ? countPatch(diff.patch) : null;
  const dir = selection ? directoryLabel(selection.path) : null;
  const name = selection ? fileName(selection.path) : '未选择文件';

  return (
    <div className="fpane">
      <div className="fpane-head">
        {onBack && (
          <button className="icon-btn" title="返回文件列表" onClick={onBack}>
            <Icon name="arrow-left" size={15} />
          </button>
        )}
        <span className="fpane-title" title={selection?.path ?? ''}>
          {dir && <span className="fpane-dir">{dir}</span>}
          <span className="fpane-name">{name}</span>
        </span>
        {diff && <span className={`fw-badge ${diff.status}`}>{STATUS_LABEL[diff.status]}</span>}
        {stats && (
          <span className="fpane-counts mono">
            <i className="add">+{stats.add}</i>
            <i className="del">−{stats.del}</i>
          </span>
        )}
        {file && <span className="fpane-size">{formatBytes(file.size)}</span>}
        <span className="fpane-spacer" />
        {selection?.kind === 'diff' && (
          /* Always available, at any width: the two columns scroll horizontally
             when the pane is narrow. Gating the control by width made it
             disappear exactly when the panel got wider (the directory column
             took the room), which is the opposite of what a view switch should do. */
          <span className="seg3" title="差异显示方式">
            <button className={view === 'split' ? 'active' : ''} onClick={() => onViewChange('split')}>
              并排
            </button>
            <button className={view === 'unified' ? 'active' : ''} onClick={() => onViewChange('unified')}>
              统一
            </button>
          </span>
        )}
        {onClose && (
          <button className="icon-btn" title="收起文件栏" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      <div className="fpane-body">
        {error ? (
          <div className="fnotice">{error}</div>
        ) : loading ? (
          <div className="fnotice">正在读取…</div>
        ) : diff ? (
          <DiffViewer diff={diff} view={view} />
        ) : file ? (
          <FileContent file={file} />
        ) : (
          <div className="fnotice">左侧选一个文件，这里显示它的内容或改动。</div>
        )}
      </div>
    </div>
  );
}

/** Additions and deletions from a unified patch. `---`/`+++` are headers, not lines. */
function countPatch(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return { add, del };
}
