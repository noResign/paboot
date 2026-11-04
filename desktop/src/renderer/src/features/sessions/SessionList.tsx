import { useMemo, useState, type ReactNode } from 'react';
import { bucketSessions, BUCKET_LABELS, type BucketId } from '../../store/sessionBuckets';
import { ContextMenu, useContextMenu, type MenuItem } from '../../ui/ContextMenu';
import { RuntimeIcon } from '../../ui/RuntimeIcon';
import { Icon } from '../../ui/Icon';
import { runtimeIdentity } from '../../../../shared/runtime-identity';
import { SessionListSkeleton } from '../../ui/Skeleton';
import type { SessionDto } from '../../../../shared/contract';

interface Props {
  sessions: SessionDto[];
  selectedId: string | null;
  /** sessionId → number of approvals waiting in it. */
  needsInput: ReadonlyMap<string, number>;
  failed: ReadonlySet<string>;
  loading: boolean;
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  onCopy(text: string): void;
  onRefresh(): void;
  /** Open this session in a second window (§7.3). */
  onOpenWindow(id: string): void;
}

/**
 * The rail's reason for existing: see which session is running or waiting on
 * you *without* switching sessions. Hence status buckets rather than a plain
 * recency sort (docs/local/pages/sessions.md §6.2).
 */
export function SessionList({
  sessions,
  selectedId,
  needsInput,
  failed,
  loading,
  onSelect,
  onRename,
  onDelete,
  onCopy,
  onRefresh,
  onOpenWindow,
}: Props) {
  // 「更早」(>3 days) starts collapsed, like the mobile clients; every other
  // bucket follows the "first two non-empty open" rule below.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ older: true });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const { menu, open, close } = useContextMenu();

  const isTaskRelated = (session: SessionDto): boolean =>
    (session.scheduledTaskCount ?? 0) > 0 || session.purpose === 'task_config';
  const taskSessions = useMemo(() => sessions.filter(isTaskRelated), [sessions]);
  const normalSessions = useMemo(() => sessions.filter((session) => !isTaskRelated(session)), [sessions]);
  const buckets = useMemo(
    () => bucketSessions({ sessions: normalSessions, needsInput: new Set(needsInput.keys()), failed }),
    [normalSessions, needsInput, failed],
  );
  const nonEmpty = buckets.filter((bucket) => bucket.sessions.length > 0);

  // "Default: the first two open" reads as the first two that actually have
  // something in them — collapsing by fixed index would hide 已完成 entirely
  // whenever the two warning buckets are empty.
  const defaultOpen = useMemo(
    () => new Set(nonEmpty.slice(0, 2).map((bucket) => bucket.id as string)),
    [nonEmpty],
  );
  const isOpen = (id: BucketId): boolean => collapsed[id] !== undefined ? !collapsed[id] : defaultOpen.has(id);

  if (loading && sessions.length === 0) return <SessionListSkeleton />;
  if (sessions.length === 0) {
    return (
      <div className="empty">
        还没有会话
        <br />
        点上方「新建会话」，或从别的电脑连接一个 daemon
      </div>
    );
  }

  function menuFor(session: SessionDto): MenuItem[] {
    return [
      { id: 'new-window', label: '在新窗口打开', run: () => onOpenWindow(session.id) },
      { id: 'rename', label: '重命名', run: () => setRenamingId(session.id) },
      { id: 'copy-cwd', label: '复制工作目录', run: () => onCopy(session.cwd) },
      { id: 'refresh', label: '刷新列表', run: onRefresh },
      { id: 'delete', label: '删除会话', danger: true, run: () => setConfirmingId(session.id) },
    ];
  }

  function renderRow(session: SessionDto): ReactNode {
    const waiting = needsInput.get(session.id) ?? 0;
    const identity = runtimeIdentity(session.runtime);
    const isRenaming = renamingId === session.id;
    const isConfirming = confirmingId === session.id;
    const taskCount = session.scheduledTaskCount ?? 0;

    return (
      <div
        key={session.id}
        className={[
          'session-row',
          session.id === selectedId ? 'selected' : '',
          session.running ? 'running' : '',
          waiting > 0 ? 'waiting' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onSelect(session.id)}
        onContextMenu={(event) => open(event, menuFor(session))}
      >
        <span className="row-marker" />

        <div className="session-info">
          {isRenaming ? (
            <input
              className="session-rename"
              autoFocus
              defaultValue={session.title ?? ''}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                setRenamingId(null);
                const next = event.target.value.trim();
                if (next && next !== session.title) onRename(session.id, next);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setRenamingId(null);
              }}
            />
          ) : (
            <div className="session-title">{session.title ?? '未命名会话'}</div>
          )}
          <div className="session-meta">
            <span className="agent" style={{ color: identity.color }} title={identity.displayName}>
              <RuntimeIcon id={session.runtime} size={11} />
              {identity.displayName}
            </span>
            {(taskCount > 0 || session.purpose === 'task_config') && (
              <>
                <span className="sep">·</span>
                <span>{taskCount > 0 ? `${taskCount} 个定时任务` : '定时任务配置'}</span>
              </>
            )}
            <span className="session-time">{relativeTime(session.lastActiveAt)}</span>
          </div>
        </div>

        {waiting > 0 && (
          <span className="wait-badge" title={`${waiting} 个待审批请求`}>
            {waiting}
          </span>
        )}
        {waiting === 0 && session.running && <span className="pulse" />}

        <div className="row-actions">
          <button
            className="icon-btn"
            title="更多操作"
            onClick={(event) => {
              event.stopPropagation();
              open(event, menuFor(session));
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>

        {isConfirming && (
          <div className="row-confirm" onClick={(event) => event.stopPropagation()}>
            <span>删除该会话？</span>
            <button
              className="btn tiny danger"
              onClick={() => {
                setConfirmingId(null);
                onDelete(session.id);
              }}
            >
              删除
            </button>
            <button className="btn tiny ghost" onClick={() => setConfirmingId(null)}>
              取消
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {nonEmpty.map((bucket) => {
        const open_ = isOpen(bucket.id);
        return (
          <section key={bucket.id} className="bucket">
            <button
              className={`bucket-head${open_ ? '' : ' collapsed'}`}
              onClick={() => setCollapsed((state) => ({ ...state, [bucket.id]: open_ }))}
              title={open_ ? '折叠' : '展开'}
            >
              <span className="chevron">
                <Icon name={open_ ? 'chevron-down' : 'chevron-right'} size={12} />
              </span>
              <span className={`bucket-label ${bucket.id}`}>{BUCKET_LABELS[bucket.id]}</span>
              <span className="bucket-count">{bucket.sessions.length}</span>
            </button>

            {open_ && bucket.sessions.map(renderRow)}
          </section>
        );
      })}

      {taskSessions.length > 0 && (
        <section className="bucket">
          <button
            className={`bucket-head${taskCollapsed ? ' collapsed' : ''}`}
            onClick={() => setTaskCollapsed((value) => !value)}
            title={taskCollapsed ? '展开' : '折叠'}
          >
            <span className="chevron">
              <Icon name={taskCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
            </span>
            <span className="bucket-label">定时任务</span>
            <span className="bucket-count">{taskSessions.length}</span>
          </button>
          {!taskCollapsed && taskSessions.map(renderRow)}
        </section>
      )}

      <ContextMenu menu={menu} onClose={close} />
    </>
  );
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  return new Date(ts).toLocaleDateString();
}
