import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { useConnection } from '../../store/connection';
import { changesKey, useFilesCache } from '../../store/files';
import { apiErrorOf, friendlyMessage } from '../../../../shared/errors';
import { formatBytes } from '../../../../shared/format';
import { directoryLabel, fileName } from './pathLabel';
import { DirectoryPickerDialog } from '../workspaces/DirectoryPickerDialog';
import type {
  ChangedFileDto,
  ChangesResponse,
  FileEntryDto,
  FilesResponse,
} from '../../../../shared/contract';

export type FileMode = 'changes' | 'all';
export interface FileSelection {
  path: string;
  kind: 'diff' | 'content';
}

const STATUS_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
};

const STATUS_CLASS: Record<string, string> = {
  modified: 'mod',
  added: 'add',
  deleted: 'del',
  renamed: 'mod',
  untracked: 'add',
  conflicted: 'del',
};

interface Props {
  workspaceId: string | null;
  /** null = the workspace's primary dir. */
  root: string | null;
  onRootChange(root: string): void;
  mode: FileMode;
  onModeChange(mode: FileMode): void;
  selectedPath: string | null;
  onSelect(selection: FileSelection): void;
  /** Scope 改动 to one run's checkpoint (`?runId=`); live dirty state when unset. */
  runId?: string;
}

/**
 * The left column of the files view — 改动 / 全部文件, root switcher, breadcrumb
 * and the listing. Extracted so the chat's right panel renders the identical
 * browser instead of a second copy (`docs/local/pages/files.md` §6.8).
 */
export function FileBrowser({
  workspaceId,
  root,
  onRootChange,
  mode,
  onModeChange,
  selectedPath,
  onSelect,
  runId,
}: Props) {
  const [dir, setDir] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  /** Bumped by 刷新 to re-run the fetch. */
  const [reload, setReload] = useState(0);

  // The change list lives in a renderer-side cache keyed by (connection,
  // workspace, root): this panel unmounts on navigation, and re-running git on
  // every open is slow exactly when it hurts — while a run rewrites the tree.
  // A cold key still falls back to `null`, which is what shows「正在读取…」.
  const connectionId = useConnection((state) => state.activeId);
  const cacheKey = connectionId && workspaceId ? changesKey(connectionId, workspaceId, root, runId) : null;
  const changes = useFilesCache((state) => (cacheKey ? state.changes[cacheKey] : undefined)) ?? null;
  const putChanges = useFilesCache((state) => state.putChanges);

  const [listing, setListing] = useState<FilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, DirExpansion>>({});
  // 「＋ 添加目录 / 移除书签」: a bookmark is a browsing-only extra root, so it lives
  // on the workspace and is added/removed here without touching session state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);

  useEffect(() => {
    setDir('');
    setExpanded({});
  }, [workspaceId, root, mode]);

  // The "all files" listing belongs to one workspace+root; blank it when that
  // changes, or the previous one would sit there behind the loading guard (which
  // only shows a spinner when there is *nothing* yet). The change list needs no
  // such reset — it is cache-keyed, so a different root is a different entry.
  useEffect(() => {
    setListing(null);
  }, [workspaceId, root]);

  useEffect(() => {
    if (!workspaceId || !cacheKey) return;
    let live = true;
    // A cached change list renders immediately and refreshes *silently*; only a
    // cold key pays the「正在读取…」state.
    const hasCached = mode === 'changes' && useFilesCache.getState().changes[cacheKey] !== undefined;
    if (!hasCached) setLoading(true);
    setError(null);
    const query = { workspaceId, root: root ?? undefined, runId };
    void (mode === 'changes' ? api.changes(query) : api.files({ ...query, path: dir, showHidden, showIgnored })).then(
      (res) => {
        if (!live) return;
        setLoading(false);
        if (!res.ok) {
          const { apiCode, message } = apiErrorOf(res.data);
          setError(friendlyMessage(apiCode, res.status, message, '读取失败'));
          return;
        }
        if (mode === 'changes') putChanges(cacheKey, res.data as ChangesResponse);
        else setListing(res.data as FilesResponse);
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, cacheKey, root, mode, dir, showHidden, showIgnored, reload, putChanges, runId]);

  /** Second click collapses; the listing is refetched on the next expand. */
  async function toggleDir(path: string): Promise<void> {
    if (expanded[path]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      return;
    }
    if (!workspaceId) return;
    setExpanded((current) => ({ ...current, [path]: { loading: true, error: null, entries: [] } }));
    const res = await api.files({ workspaceId, root: root ?? undefined, path });
    setExpanded((current) => ({
      ...current,
      [path]: res.ok
        ? { loading: false, error: null, entries: (res.data as FilesResponse).entries }
        : { loading: false, error: '读取失败', entries: [] },
    }));
  }

  async function loadMore(): Promise<void> {
    if (!workspaceId || !listing?.nextCursor) return;
    const res = await api.files({
      workspaceId,
      root: root ?? undefined,
      path: dir,
      cursor: listing.nextCursor,
      showHidden,
      showIgnored,
    });
    if (!res.ok) return;
    setListing((current) =>
      current ? { ...res.data, entries: [...current.entries, ...res.data.entries] } : res.data,
    );
  }

  const roots = changes?.roots ?? listing?.roots ?? [];
  const shortcuts = changes?.shortcutDirs ?? listing?.shortcutDirs ?? [];
  const activeRoot = root ?? changes?.root ?? listing?.root ?? '';
  const changeCount = changes?.files.length ?? 0;
  const activeIsShortcut = activeRoot !== '' && shortcuts.includes(activeRoot);

  /** Add a bookmark and switch to it — the point of adding one is to look inside. */
  async function addBookmark(path: string): Promise<void> {
    if (!workspaceId) return;
    setPickerBusy(true);
    setBookmarkError(null);
    const res = await api.addWorkspaceShortcut(workspaceId, path);
    setPickerBusy(false);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      // 409 shortcut_exists 等要留在弹窗里说清楚，别关掉再让人猜。
      setBookmarkError(friendlyMessage(apiCode, res.status, message, '无法添加目录'));
      return;
    }
    setPickerOpen(false);
    onRootChange(path);
  }

  async function removeActiveBookmark(): Promise<void> {
    if (!workspaceId || !activeIsShortcut) return;
    setBookmarkError(null);
    const res = await api.removeWorkspaceShortcut(workspaceId, activeRoot);
    if (!res.ok) {
      const { apiCode, message } = apiErrorOf(res.data);
      setBookmarkError(friendlyMessage(apiCode, res.status, message, '无法移除书签'));
      return;
    }
    // Fall back to the workspace's primary dir, which is always roots[0]. The root
    // change alone re-runs the fetch, so the refreshed `shortcutDirs` comes back.
    onRootChange(roots[0] ?? '');
  }

  return (
    <div className="ftree">
      <div className="fseg">
        <button className={mode === 'changes' ? 'active' : ''} onClick={() => onModeChange('changes')}>
          改动{mode === 'changes' && changes ? ` (${changeCount})` : ''}
        </button>
        <button className={mode === 'all' ? 'active' : ''} onClick={() => onModeChange('all')}>
          全部文件
        </button>
      </div>

      <div className="ftree-toolbar">
        <select className="ws-select" value={activeRoot} onChange={(event) => onRootChange(event.target.value)}>
          {roots.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
          {shortcuts.map((item) => (
            <option key={item} value={item}>
              ★ {item}
            </option>
          ))}
        </select>
        <div className="ftree-buttons">
          <button className="btn tiny" onClick={() => setShowHidden((value) => !value)}>
            {showHidden ? '隐藏隐藏项' : '显示隐藏项'}
          </button>
          {mode === 'all' && (
            <button className="btn tiny" onClick={() => setShowIgnored((value) => !value)}>
              {showIgnored ? '隐藏忽略项' : '显示忽略项'}
            </button>
          )}
          <button
            className="btn tiny"
            disabled={!workspaceId}
            onClick={() => {
              setBookmarkError(null);
              setPickerOpen(true);
            }}
            title="浏览并固定一个工作区之外的目录"
          >
            ＋ 添加目录
          </button>
          {activeIsShortcut && (
            <button className="btn tiny" onClick={() => void removeActiveBookmark()} title="从书签中移除这个目录">
              移除书签
            </button>
          )}
          <button className="btn tiny" onClick={() => setReload((value) => value + 1)} title="刷新">
            刷新
          </button>
        </div>
      </div>

      {bookmarkError && !pickerOpen && <div className="fnotice">{bookmarkError}</div>}

      {mode === 'all' && (
        <div className="fbreadcrumb mono">
          <button className="fbreadcrumb-root" onClick={() => setDir('')} title={activeRoot}>
            /
          </button>
          {dir
            .split('/')
            .filter(Boolean)
            .map((segment, index, all) => (
              <button
                key={index}
                className="fbreadcrumb-seg"
                onClick={() => setDir(all.slice(0, index + 1).join('/'))}
              >
                {segment}
              </button>
            ))}
        </div>
      )}

      <div className="ftree-body">
        {error ? (
          <div className="fnotice">{error}</div>
        ) : loading && !(mode === 'changes' ? changes : listing) ? (
          <div className="fnotice">正在读取…</div>
        ) : mode === 'changes' ? (
          <ChangesList
            changes={changes}
            selected={selectedPath}
            expanded={expanded}
            onToggleDir={(path) => void toggleDir(path)}
            onPick={(path, kind) => onSelect({ path, kind })}
          />
        ) : (
          <AllFilesList
            listing={listing}
            selected={selectedPath}
            onOpenDir={setDir}
            onPick={(path) => onSelect({ path, kind: 'content' })}
            onLoadMore={() => void loadMore()}
          />
        )}
      </div>

      {pickerOpen && (
        <DirectoryPickerDialog
          mode="shortcut"
          workspacePaths={[]}
          busy={pickerBusy}
          error={bookmarkError}
          onClose={() => {
            setPickerOpen(false);
            setBookmarkError(null);
          }}
          onPick={(path) => void addBookmark(path)}
        />
      )}
    </div>
  );
}

/** One expanded untracked directory (git collapses those into a single entry). */
interface DirExpansion {
  loading: boolean;
  error: string | null;
  entries: FileEntryDto[];
}

interface Row {
  path: string;
  isDirectory: boolean;
  badge: string | null;
  badgeClass: string;
  additions?: number | null;
  deletions?: number | null;
}

const changedRow = (item: ChangedFileDto): Row => ({
  path: item.path,
  isDirectory: item.isDirectory,
  badge: STATUS_LETTER[item.status] ?? '?',
  badgeClass: STATUS_CLASS[item.status] ?? 'mod',
  additions: item.additions,
  deletions: item.deletions,
});

/** Everything under an untracked directory is new by definition. */
const childRow = (entry: FileEntryDto): Row => ({
  path: entry.path,
  isDirectory: entry.type === 'directory',
  badge: 'A',
  badgeClass: 'add',
});

/** Second line of a changed row: shortened directory, plus counts when reported. */
function rowSubline(row: Row): string | null {
  const counts = row.additions != null || row.deletions != null ? `+${row.additions ?? 0} −${row.deletions ?? 0}` : '';
  const joined = [directoryLabel(row.path), counts].filter(Boolean).join('  ');
  return joined || null;
}

function ChangesList({
  changes,
  selected,
  expanded,
  onToggleDir,
  onPick,
}: {
  changes: ChangesResponse | null;
  selected: string | null;
  expanded: Record<string, DirExpansion>;
  onToggleDir(path: string): void;
  onPick(path: string, kind: 'diff' | 'content'): void;
}) {
  if (!changes) return null;
  if (!changes.isGitRepo) {
    return <div className="fnotice">此目录不是 Git 仓库。切到「全部文件」照样能浏览。</div>;
  }
  if (changes.files.length === 0) {
    return <div className="fnotice">没有未提交的改动。</div>;
  }
  return (
    <>
      {changes.files.map((item) => (
        <ChangeNode
          key={item.path}
          row={changedRow(item)}
          depth={0}
          selected={selected}
          expanded={expanded}
          onToggleDir={onToggleDir}
          onPick={onPick}
        />
      ))}
    </>
  );
}

/**
 * A changed file opens its diff; a changed *directory* (an untracked one — git
 * folds those into one entry) expands in place instead, because the daemon
 * cannot diff a directory and never reported its children. Those children come
 * from the file browser and open as content: for an untracked file the whole
 * file *is* the addition, so there is nothing a diff would add.
 */
function ChangeNode({
  row,
  depth,
  selected,
  expanded,
  onToggleDir,
  onPick,
}: {
  row: Row;
  depth: number;
  selected: string | null;
  expanded: Record<string, DirExpansion>;
  onToggleDir(path: string): void;
  onPick(path: string, kind: 'diff' | 'content'): void;
}) {
  const indent = { paddingLeft: 8 + depth * 12 };
  const state = expanded[row.path];
  const sub = rowSubline(row);

  if (!row.isDirectory) {
    return (
      <button
        className={`fnode fnode-rich${row.path === selected ? ' active' : ''}`}
        style={indent}
        title={row.path}
        onClick={() => onPick(row.path, depth === 0 ? 'diff' : 'content')}
      >
        <span className="frow-main">
          <span className="fname">{fileName(row.path)}</span>
          {row.badge && <span className={`st ${row.badgeClass}`}>{row.badge}</span>}
        </span>
        {sub && <span className="frow-sub">{sub}</span>}
      </button>
    );
  }

  return (
    <>
      <button className="fnode fnode-rich" style={indent} title={row.path} onClick={() => onToggleDir(row.path)}>
        <span className="frow-main">
          <span className="fchev">{state ? '▾' : '▸'}</span>
          <span className="fname">📁 {fileName(row.path)}</span>
          {row.badge && <span className={`st ${row.badgeClass}`}>{row.badge}</span>}
        </span>
        {sub && <span className="frow-sub frow-sub-indent">{sub}</span>}
      </button>
      {state?.loading && (
        <div className="fnotice" style={{ paddingLeft: indent.paddingLeft + 12 }}>
          读取中…
        </div>
      )}
      {state?.error && (
        <div className="fnotice" style={{ paddingLeft: indent.paddingLeft + 12 }}>
          {state.error}
        </div>
      )}
      {state?.entries.map((entry) => (
        <ChangeNode
          key={entry.path}
          row={childRow(entry)}
          depth={depth + 1}
          selected={selected}
          expanded={expanded}
          onToggleDir={onToggleDir}
          onPick={onPick}
        />
      ))}
      {state && !state.loading && !state.error && state.entries.length === 0 && (
        <div className="fnotice" style={{ paddingLeft: indent.paddingLeft + 12 }}>
          这个目录是空的。
        </div>
      )}
    </>
  );
}

function AllFilesList({
  listing,
  selected,
  onOpenDir,
  onPick,
  onLoadMore,
}: {
  listing: FilesResponse | null;
  selected: string | null;
  onOpenDir(path: string): void;
  onPick(path: string): void;
  onLoadMore(): void;
}) {
  if (!listing) return null;
  if (listing.entries.length === 0) return <div className="fnotice">这个目录是空的。</div>;
  return (
    <>
      {listing.entries.map((entry) => (
        <button
          key={entry.path}
          className={`fnode${entry.path === selected ? ' active' : ''}`}
          title={entry.path}
          onClick={() => (entry.type === 'directory' ? onOpenDir(entry.path) : onPick(entry.path))}
        >
          <span className="fname">
            {entry.type === 'directory' ? '📁 ' : ''}
            {entry.name}
          </span>
          {entry.type === 'file' && entry.size !== null && <span className="fsize">{formatBytes(entry.size)}</span>}
        </button>
      ))}
      {listing.nextCursor && (
        <button className="btn ghost tiny" style={{ margin: 6 }} onClick={onLoadMore}>
          加载更多
        </button>
      )}
    </>
  );
}
