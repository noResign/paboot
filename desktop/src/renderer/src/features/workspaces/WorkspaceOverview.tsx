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
import { DevicePanel } from '../device/DevicePanel';
import { KnowledgePanel } from '../knowledge/KnowledgePanel';
import { MockPanel } from '../mock/MockPanel';
import { MemoryPanel } from '../memory/MemoryPanel';
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
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);

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

  // The dev fallback is a technical scratch (no overview); family=life is a
  // real, built-in workspace and must still render (as「生活」).
  if (!workspace || (workspace.isBuiltin && workspace.family !== 'life')) {
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

  const isLife = workspace.family === 'life';
  const dirs = workspaceDirectories(workspace);
  const recent = recentSessions(sessions, 8);
  // `sessions` is empty until the workspace's batch lands, so "no sessions in
  // this dir" is not yet evidence: removal stays off until it is loaded.
  const sessionsLoaded = scope.sessionsWorkspaceId === workspace.id;

  function dirMenu(dir: string, stats: ReturnType<typeof directoryStats>, main: boolean): MenuItem[] {
    const items: MenuItem[] = [{ id: 'copy', label: '复制路径', run: () => onCopy(dir) }];
    // The primary dir is not removable (v1 has no "change primary").
    if (main) return items;
    const blocked = stats.count > 0;
    return [
      ...items,
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
          {!isLife && (
            <button className="btn ghost" onClick={onOpenSettings}>
              工作区设置
            </button>
          )}
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
        <p className="hint">
          {dirs.length > 1
            ? '附加目录会扩大这个工作区所有会话的可写范围，不是只给当前对话。'
            : '还没有附加目录，可以在「添加目录」里把别的目录加进来。'}
        </p>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>记忆</h3>
        </div>
        <button
          type="button"
          className="wo-knowledge"
          onClick={() => setMemoryOpen(true)}
          aria-label="打开记忆"
        >
          <span className="wo-knowledge-icon">
            <Icon name="eye" size={18} />
          </span>
          <span className="wo-knowledge-copy">
            <b>记忆</b>
            <span className="hint">
              {isLife
                ? '生活会话里的长期事实会自动整理；新会话按记忆注入，可查看来源、改正或忘记。'
                : '这个工作区的长期记忆默认关闭；打开后可启用捕获、整理与注入。'}
            </span>
            <span className="wo-knowledge-meta">
              <span className="wo-knowledge-chip">{isLife ? '自动整理' : '默认关闭'}</span>
              <span className="wo-knowledge-chip">
                {isLife ? '来源可追溯' : '可允许生活读取'}
              </span>
              <span className="wo-knowledge-chip">secret 不注入</span>
            </span>
          </span>
          <span className="wo-knowledge-action">
            {isLife ? '查看记忆' : '打开记忆'}
            <Icon name="chevron-right" size={14} />
          </span>
        </button>
      </section>

      {!isLife && (
        <section className="settings-section">
          <div className="section-head">
            <h3>知识</h3>
          </div>
          <button
            type="button"
            className="wo-knowledge"
            onClick={() => setKnowledgeOpen(true)}
            aria-label="管理工作区知识"
          >
            <span className="wo-knowledge-icon">
              <Icon name="folder" size={18} />
            </span>
            <span className="wo-knowledge-copy">
              <b>工作区知识</b>
              <span className="hint">
                项目约定、决策、踩坑和需求会自动收录，并在新会话首条消息里按路径注入。
              </span>
              <span className="wo-knowledge-meta">
                <span className="wo-knowledge-chip">自动收录</span>
                <span className="wo-knowledge-chip">按路径注入</span>
                <span className="wo-knowledge-chip">未核验标注</span>
                <span className="wo-knowledge-path mono">~/.paboot/workspaces/&lt;id&gt;/</span>
              </span>
            </span>
            <span className="wo-knowledge-action">
              管理知识
              <Icon name="chevron-right" size={14} />
            </span>
          </button>
        </section>
      )}

      <section className="settings-section">
        <div className="section-head">
          <h3>最近会话</h3>
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

      {!isLife && (
        <section className="settings-section">
          <div className="section-head">
            <h3>端 / 能力</h3>
          </div>
          <button
            type="button"
            className="wo-knowledge"
            onClick={() => setDeviceOpen(true)}
            aria-label="打开 Android 设备能力"
          >
            <span className="wo-knowledge-icon">
              <Icon name="eye" size={18} />
            </span>
            <span className="wo-knowledge-copy">
              <b>Android 设备</b>
              <span className="hint">
                通过 adb 镜像设备画面、点击与输入；需要先在工作区里添加一个 Android 端。
              </span>
              <span className="wo-knowledge-meta">
                <span className="wo-knowledge-chip">device</span>
                <span className="wo-knowledge-chip">需审批</span>
                <span className="wo-knowledge-chip">dev 专用</span>
              </span>
            </span>
            <span className="wo-knowledge-action">
              打开设备
              <Icon name="chevron-right" size={14} />
            </span>
          </button>
          <button
            type="button"
            className="wo-knowledge"
            onClick={() => setMockOpen(true)}
            aria-label="打开 Mock API"
          >
            <span className="wo-knowledge-icon">
              <Icon name="file" size={18} />
            </span>
            <span className="wo-knowledge-copy">
              <b>Mock API</b>
              <span className="hint">
                一条接口一个 JSON；agent 直接改文件，面板保存后立即生效，可编辑 baseline /
                scenarios / rules。
              </span>
              <span className="wo-knowledge-meta">
                <span className="wo-knowledge-chip">文件即 fixture</span>
                <span className="wo-knowledge-chip">热更新</span>
                <span className="wo-knowledge-chip">dev 专用</span>
              </span>
            </span>
            <span className="wo-knowledge-action">
              编辑 Mock
              <Icon name="chevron-right" size={14} />
            </span>
          </button>
        </section>
      )}

      {pickerDialog}
      {knowledgeOpen && (
        <KnowledgePanel
          workspaceId={workspace.id}
          workspaceName={workspaceLabel(workspace) ?? workspace.name}
          onClose={() => setKnowledgeOpen(false)}
        />
      )}
      {memoryOpen && (
        <MemoryPanel
          workspaceId={workspace.id}
          workspaceName={workspaceLabel(workspace) ?? workspace.name}
          family={workspace.family === 'life' ? 'life' : 'dev'}
          onClose={() => setMemoryOpen(false)}
        />
      )}
      {deviceOpen && (
        <DevicePanel
          workspaceId={workspace.id}
          workspaceName={workspaceLabel(workspace) ?? workspace.name}
          onClose={() => setDeviceOpen(false)}
        />
      )}
      {mockOpen && (
        <MockPanel
          workspaceId={workspace.id}
          workspaceName={workspaceLabel(workspace) ?? workspace.name}
          onClose={() => setMockOpen(false)}
        />
      )}
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
