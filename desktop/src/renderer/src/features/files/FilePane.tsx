import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import { formatBytes } from '../../../../shared/format';
import { DiffViewer, type DiffView } from './DiffViewer';
import { FileContent } from './FileContent';
import type { FileSelection } from './FileBrowser';
import type { DiffResponse, FileContentDto } from '../../../../shared/contract';

interface Props {
  workspaceId: string | null;
  root: string | null;
  selection: FileSelection | null;
  view: DiffView;
  /** The page header explains the degradation; the panel is too narrow for it. */
  narrowHint?: boolean;
  emptyText?: string;
  /** Scope the diff to one run's checkpoint (`?runId=`). */
  runId?: string;
}

/**
 * The content half: header (path / size / diff counts) plus the diff or text
 * viewer. Shared by the files page and the chat's right panel.
 */
export function FilePane({ workspaceId, root, selection, view, narrowHint, emptyText, runId }: Props) {
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
    const query = { workspaceId, root: root ?? undefined, path: selection.path, runId };
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
  }, [workspaceId, root, selection, runId]);

  const additions = diff && !diff.binary
    ? diff.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    : null;

  return (
    <div className="fpane">
      <div className="fpane-head">
        <span className="mono fpane-path">{selection?.path ?? '未选择文件'}</span>
        {additions !== null && <span className="badge">+{additions}</span>}
        {file && <span className="hint" style={{ margin: 0 }}>{formatBytes(file.size)}</span>}
        {diff && narrowHint && <span className="hint" style={{ margin: 0 }}>窗口偏窄，已用统一视图</span>}
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
          <div className="fnotice">{emptyText ?? '左侧选一个文件，这里显示它的内容或改动。'}</div>
        )}
      </div>
    </div>
  );
}
