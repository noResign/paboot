import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import { DiffViewer, type DiffView } from './DiffViewer';
import type { ChangedFileDto, DiffResponse } from '../../../../shared/contract';

const STATUS_LETTER: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
};

interface Props {
  files: ChangedFileDto[];
  workspaceId: string | null;
  root: string | null;
  view: DiffView;
  /** Scope every file's diff to one run's checkpoint. */
  runId?: string;
}

/**
 * The 改动 list rendered as one continuous scroll: every changed file's diff,
 * stacked. Each file's patch is fetched only once it scrolls near the viewport,
 * so opening a large change set does not fire one request per file up front.
 */
export function ChangesFeed({ files, workspaceId, root, view, runId }: Props) {
  if (files.length === 0) return <div className="fnotice">没有改动。</div>;
  return (
    <div className="fdiff-feed">
      {files.map((file) => (
        <FeedFile key={file.path} file={file} workspaceId={workspaceId} root={root} runId={runId} view={view} />
      ))}
    </div>
  );
}

function FeedFile({
  file,
  workspaceId,
  root,
  runId,
  view,
}: {
  file: ChangedFileDto;
  workspaceId: string | null;
  root: string | null;
  runId?: string;
  view: DiffView;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch a file's patch only once it is close to the viewport.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !workspaceId) return;
    let live = true;
    setLoading(true);
    void api
      .changesDiff({ workspaceId, root: root ?? undefined, path: file.path, runId })
      .then((res) => {
        if (!live) return;
        setLoading(false);
        if (!res.ok) {
          const { apiCode, message } = apiErrorOf(res.data);
          setError(friendlyMessage(apiCode, res.status, message, '读取失败'));
          return;
        }
        setDiff(res.data as DiffResponse);
      });
    return () => {
      live = false;
    };
  }, [visible, workspaceId, root, file.path, runId]);

  const stat =
    file.additions !== null || file.deletions !== null
      ? `+${file.additions ?? 0} −${file.deletions ?? 0}`
      : '';

  return (
    <div className="fdiff-file" ref={ref}>
      <div className="fdiff-file-head">
        <span className={`fdiff-file-status s-${file.status}`}>{STATUS_LETTER[file.status] ?? 'M'}</span>
        <span className="mono fdiff-file-path" title={file.path}>
          {file.path}
        </span>
        {file.oldPath && <span className="hint" style={{ margin: 0 }}>← {file.oldPath}</span>}
        <span className="fdiff-file-stat">{stat}</span>
      </div>
      <div className="fdiff-file-body">
        {error ? (
          <div className="fnotice">{error}</div>
        ) : !visible || loading ? (
          <div className="fnotice">正在读取…</div>
        ) : diff ? (
          <DiffViewer diff={diff} view={view} />
        ) : null}
      </div>
    </div>
  );
}
