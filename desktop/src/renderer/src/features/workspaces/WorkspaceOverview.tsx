import { useEffect, useState } from 'react';
import { useSessions, useScope } from '../../store/sessions';
import {
  directoryName,
  directoryStats,
  recentSessions,
  workspaceDirectories,
  workspaceLabel,
} from '../../store/workspaceList';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';
import { ContextMenu, useContextMenu, type MenuItem } from '../../ui/ContextMenu';
import { Icon } from '../../ui/Icon';
import { RuntimeIcon } from '../../ui/RuntimeIcon';
import { runtimeIdentity } from '../../../../shared/runtime-identity';
import type { SessionDto, WorkspaceDto } from '../../../../shared/contract';

interface Props {
  connectionId: string;
  workspace: WorkspaceDto | null;
  sessions: SessionDto[];
  onNewSession(): void;
  onOpenSession(id: string): void;
  /** Apply a rail directory filter; `null` clears it. */
  onFilterDir(dir: string | null): void;
  onCopy(text: string): void;
  onOpenSettings(): void;
  onWorkspaceCreated(id: string): void;
  /** Return to the session the overview was opened from, when there is one. */
  onBack?(): void;
}

type PickerMode = 'create' | 'add-dir';

/**
 * 「工作区概览」(desktop §6.2a): the main area shown when no session is open.
 * It is a read/operate surface over `workspaces.path` + `workspace_dirs`; no
 * project layer, and no backend calls the rail does not already make.
 */
export function WorkspaceOverview({
  connectionId,
  workspace,
  sessions,
  onNewSession,
  onOpenSession,
  onFilterDir,
  onCopy,
  onOpenSettings,
  onWorkspaceCreated,
  onBack,
}: Props) {
  const scope = useScope(connectionId);
  const createWorkspace = useSessions((state) => state.createWorkspace);
  const addWorkspaceDir = useSessions((state) => state.addWorkspaceDir);
  const removeWorkspaceDir = useSessions((state) => state.removeWorkspaceDir);
  const { menu, open, close } = useContextMenu();

  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  function openPicker(mode: PickerMode): void {
    setPickerError(null);
    setPicker(mode);
  }

  async function pickDirectory(path: string): Promise<void> {
    if (!picker) return;
    setPickerBusy(true);
    setPickerError(null);
    const res =
      picker === 'create'
        ? await createWorkspace(connectionId, path)
        : workspace
          ? await addWorkspaceDir(connectionId, workspace.id, path)
          : { ok: false as const, error: '工作区不存在' };
    setPickerBusy(false);
    if (!res.ok) {
      setPickerError(res.error);
      return;
    }
    setPicker(null);
    if (picker === 'create') {
      setNotice('工作区已添加');
      if (res.workspace) onWorkspaceCreated(res.workspace.id);
    } else {
      setNotice('附加目录已添加');
    }
  }

  async function removeDir(dir: string): Promise<void> {
    if (!workspace) return;
    const res = await removeWorkspaceDir(connectionId, workspace.id, dir);
    setNotice(res.ok ? '已移除附加目录' : res.error);
  }

  const pickerDialog = picker && (
    <DirectoryPickerDialog
      mode={picker}
      workspacePaths={scope.workspaces.map((item) => item.path)}
      busy={pickerBusy}
      error={pickerError}
      onClose={() => setPicker(null)}
      onPick={(path) => void pickDirectory(path)}
    />
  );

  if (!workspace || workspace.isBuiltin) {
    return (
      <div className="workspace-overview">
        <div className="wo-empty settings-section">
          <h3>还没有添加工作区</h3>
          <p className="hint">
            工作区决定会话在哪个目录运行、能写到哪里。内置工作区只是临时的技术目录，不参与管理。
          </p>
          <div className="wo-actions">
            <button className="btn primary" onClick={() => openPicker('create')}>
              <Icon name="plus" size={15} />
              添加工作区
            </button>
            <button className="btn" onClick={onNewSession}>
              仍在内置工作区新建会话
            </button>
          </div>
        </div>
        {pickerDialog}
        {notice && <div className="ws-notice">{notice}</div>}
      </div>
    );
  }

  const dirs = workspaceDirectories(workspace);
  const recent = recentSessions(sessions, 8);
  // `sessions` is empty until the workspace's batch lands, so "no sessions in
  // this dir" is not yet evidence: removal stays off until it is loaded.
  const sessionsLoaded = scope.sessionsWorkspaceId === workspace.id;

  function dirMenu(dir: string, stats: ReturnType<typeof directoryStats>, main: boolean): MenuItem[] {
    const items: MenuItem[] = [{ id: 'copy', label: '复制路径', run: () => onCopy(dir) }];
    // The primary dir is not removable (v1 has no "change primary"), and
    // filtering by it would match every session while the rail hides the
    // filter for a single-dir workspace — so neither item belongs on its row.
    if (main) return items;
    const blocked = stats.count > 0;
    return [
      ...items,
      { id: 'filter', label: '在会话列表筛选此目录', run: () => onFilterDir(dir) },
      {
        id: 'remove',
        label: !sessionsLoaded
          ? '移除附加目录（会话加载中）'
          : blocked
            ? `移除附加目录（仍有 ${stats.count} 个会话）`
            : '移除附加目录',
        danger: true,
        disabled: !sessionsLoaded || blocked,
        run: () => void removeDir(dir),
      },
    ];
  }

  return (
    <div className="workspace-overview">
      <header className="wo-head">
        <div className="wo-head-main">
          {onBack && (
            <button className="icon-btn wo-back" title="返回会话" onClick={onBack}>
              <Icon name="chevron-left" size={16} />
            </button>
          )}
          <div className="wo-title">
            <h1>{workspaceLabel(workspace)}</h1>
            <button className="mono wo-path" title="点击复制主目录路径" onClick={() => onCopy(workspace.path)}>
              {workspace.path}
            </button>
          </div>
        </div>
        <div className="wo-actions">
          <button className="btn primary" onClick={onNewSession}>
            <Icon name="plus" size={15} />
            新建会话
          </button>
          <button className="btn" onClick={() => openPicker('add-dir')}>
            <Icon name="plus" size={15} />
            添加目录
          </button>
          <button className="btn ghost" onClick={onOpenSettings}>
            工作区设置
          </button>
        </div>
      </header>

      <section className="settings-section">
        <div className="section-head">
          <h3>目录</h3>
          <span className="wo-count">{dirs.length}</span>
        </div>
        {dirs.map((dir, index) => {
          const main = index === 0;
          const stats = directoryStats(sessions, dir);
          return (
            <div className={`wo-dir-row${main ? ' is-main' : ''}`} key={dir}>
              <div className="wo-dir-main">
                <div className="wo-dir-label">
                  <span className="wo-dir-icon">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className={`badge${main ? '' : ' subtle'}`}>{main ? '主目录' : '附加目录'}</span>
                  <button className="mono wo-dir-path" title="点击复制" onClick={() => onCopy(dir)}>
                    {dir}
                  </button>
                </div>
                <div className="wo-dir-meta">
                  <span>{stats.count} 个会话</span>
                  {stats.lastUsedAt > 0 && (
                    <>
                      <span className="sep">·</span>
                      <span>最近 {relativeTime(stats.lastUsedAt)}</span>
                    </>
                  )}
                  {!main && stats.count > 0 && (
                    <>
                      <span className="sep">·</span>
                      <span>仍有会话，先迁移或删除会话</span>
                    </>
                  )}
                </div>
              </div>
              <div className="wo-dir-actions">
                <button className="icon-btn" title="复制路径" onClick={() => onCopy(dir)}>
                  <Icon name="copy" size={14} />
                </button>
                <button
                  className="icon-btn"
                  title="更多操作"
                  onClick={(event) => open(event, dirMenu(dir, stats, main))}
                >
                  <Icon name="more" size={15} />
                </button>
              </div>
            </div>
          );
        })}
        <p className="hint">附加目录会扩大这个工作区所有会话的可写范围，不是只给当前对话。</p>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>最近会话</h3>
          {dirs.length > 1 && (
            <button className="btn ghost tiny" onClick={() => onFilterDir(null)}>
              查看全部
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <p className="hint">还没有会话。点上方「新建会话」开始。</p>
        ) : (
          recent.map((session) => {
            const identity = runtimeIdentity(session.runtime);
            return (
              <button className="wo-session" key={session.id} onClick={() => onOpenSession(session.id)}>
                <span className="wo-session-title">{session.title ?? '未命名会话'}</span>
                <span className="wo-session-meta">
                  <span style={{ color: identity.color }}>
                    <RuntimeIcon id={session.runtime} size={11} />
                  </span>
                  {identity.displayName}
                  <span className="sep">·</span>
                  {directoryName(session.cwd)}
                  <span className="sep">·</span>
                  {relativeTime(session.lastActiveAt)}
                </span>
              </button>
            );
          })
        )}
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>端 / 能力</h3>
        </div>
        <div className="wo-placeholder">
          <Icon name="plus" size={16} />
          <div>
            <b>添加端 / 能力</b>
            <div className="hint">按端管理目录、设备与 Mock 的能力配置将在后续版本开放。</div>
          </div>
        </div>
      </section>

      {pickerDialog}
      {notice && <div className="ws-notice">{notice}</div>}
      <ContextMenu menu={menu} onClose={close} />
    </div>
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
