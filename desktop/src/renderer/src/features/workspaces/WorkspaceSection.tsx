import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { useConnection } from '../../store/connection';
import { useScope, useSessions, type WorkspaceMutation } from '../../store/sessions';
import { ContextMenu, useContextMenu, type MenuItem } from '../../ui/ContextMenu';
import { visibleWorkspaces } from '../../store/workspaceList';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';
import type { WorkspaceDto } from '../../../../shared/contract';

type PickerState = { mode: 'create' | 'add-dir'; workspaceId?: string };

/**
 * 工作区管理 (`docs/local/pages/settings.md` §6.9 ⑧), rendered as the 「工作区」
 * section of the settings page — the design puts it in the snav, not on a page
 * of its own. Delete is a hover button + right-click item here, where the phone
 * swipes (`desktop_ui_design.md` §7.2).
 */
export function WorkspaceSection() {
  const connectionId = useConnection((state) => state.activeId);
  const scope = useScope(connectionId);

  const createWorkspace = useSessions((state) => state.createWorkspace);
  const updateWorkspace = useSessions((state) => state.updateWorkspace);
  const deleteWorkspace = useSessions((state) => state.deleteWorkspace);
  const addWorkspaceDir = useSessions((state) => state.addWorkspaceDir);
  const removeWorkspaceDir = useSessions((state) => state.removeWorkspaceDir);

  const { menu, open, close } = useContextMenu();
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [rename, setRename] = useState<WorkspaceDto | null>(null);
  const [renameText, setRenameText] = useState('');
  const [removing, setRemoving] = useState<WorkspaceDto | null>(null);
  const [cascade, setCascade] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const workspacePaths = useMemo(() => scope.workspaces.map((item) => item.path), [scope.workspaces]);
  // The built-in fallback is usable (it holds the session/file id) but is not a
  // workspace the user manages, so it never gets a card here.
  const managedWorkspaces = useMemo(() => visibleWorkspaces(scope.workspaces), [scope.workspaces]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Runs a mutation, routing its failure (or a success line) into the banner. */
  async function run(id: string, action: () => Promise<WorkspaceMutation>, success: string): Promise<void> {
    setBusyId(id);
    const res = await action();
    setBusyId(null);
    setNotice(res.ok ? success : res.error);
  }

  /** Same, but only when connected — the section is reachable before a target exists. */
  function mutate(id: string, action: (cid: string) => Promise<WorkspaceMutation>, success: string): void {
    if (!connectionId) return;
    void run(id, () => action(connectionId), success);
  }

  function openPicker(state: PickerState): void {
    setPickerError(null);
    setPicker(state);
  }

  async function pickDirectory(path: string): Promise<void> {
    if (!connectionId || !picker) return;
    const { mode, workspaceId } = picker;
    setPickerBusy(true);
    setPickerError(null);
    const res =
      mode === 'create'
        ? await createWorkspace(connectionId, path)
        : await addWorkspaceDir(connectionId, workspaceId as string, path);
    setPickerBusy(false);
    if (!res.ok) {
      setPickerError(res.error);
      return;
    }
    setPicker(null);
    setNotice(mode === 'create' ? '工作区已新增' : '附加目录已添加');
  }

  async function confirmRename(): Promise<void> {
    if (!connectionId || !rename) return;
    const name = renameText.trim();
    if (!name) {
      setNotice('名称不能为空');
      return;
    }
    const res = await updateWorkspace(connectionId, rename.id, { name });
    if (!res.ok) {
      setNotice(res.error);
      return;
    }
    setRename(null);
    setNotice('已重命名');
  }

  async function confirmDelete(): Promise<void> {
    if (!connectionId || !removing) return;
    const target = removing;
    const res = await deleteWorkspace(connectionId, target.id, cascade);
    if (!res.ok) {
      setNotice(res.error);
      return;
    }
    setRemoving(null);
    setNotice(
      cascade && target.sessionCount > 0 ? `已删除工作区与 ${target.sessionCount} 个会话` : '工作区已删除',
    );
  }

  function menuFor(workspace: WorkspaceDto): MenuItem[] {
    return [
      {
        id: 'toggle',
        label: workspace.enabled ? '禁用' : '启用',
        run: () =>
          mutate(
            workspace.id,
            (cid) => updateWorkspace(cid, workspace.id, { enabled: !workspace.enabled }),
            workspace.enabled ? '已禁用' : '已启用',
          ),
      },
      { id: 'rename', label: '重命名', run: () => { setRename(workspace); setRenameText(workspace.name); } },
      { id: 'add-dir', label: '添加附加目录', run: () => openPicker({ mode: 'add-dir', workspaceId: workspace.id }) },
      {
        id: 'delete',
        label: '删除',
        danger: true,
        run: () => {
          setCascade(false);
          setRemoving(workspace);
        },
      },
    ];
  }

  return (
    <>
      <div className="settings-section">
        <div className="section-head">
          <h3>工作区</h3>
          <button className="btn tiny" onClick={() => openPicker({ mode: 'create' })}>
            ＋ 新增工作区
          </button>
        </div>
        <div className="hint" style={{ marginTop: 0 }}>
          新建会话时选一个工作区，它的主目录就是 agent 的工作目录。「附加目录」是该工作区所有会话
          共用的可达目录，也是唯一的增删入口。
        </div>
      </div>

      {managedWorkspaces.length === 0 ? (
        <div className="settings-section">
          <div className="hint" style={{ marginTop: 0 }}>
            还没有添加工作区，点「＋ 新增工作区」添加一个。
          </div>
        </div>
      ) : (
        managedWorkspaces.map((workspace) => (
          <div
            key={workspace.id}
            className="settings-section ws-card"
            onContextMenu={(event) => open(event, menuFor(workspace))}
          >
            <div className="ws-card-head">
              <div className="ws-card-title">
                <b>{workspace.name || workspace.path}</b>
                {!workspace.enabled && <span className="badge warn">已禁用</span>}
              </div>
              <button
                className="btn ghost tiny ws-delete"
                onClick={() => {
                  setCascade(false);
                  setRemoving(workspace);
                }}
              >
                删除
              </button>
            </div>

            <div className="mono ws-card-path" title={workspace.path}>
              {workspace.path}
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {workspace.sessionCount} 个会话
            </div>

            {workspace.dirs.map((dir) => (
              <div className="ws-dir-row" key={dir}>
                <span className="mono ws-dir-path" title={dir}>
                  ＋ {dir}
                </span>
                <button
                  className="btn ghost tiny"
                  disabled={busyId === workspace.id}
                  onClick={() =>
                    mutate(workspace.id, (cid) => removeWorkspaceDir(cid, workspace.id, dir), '已移除附加目录')
                  }
                >
                  移除
                </button>
              </div>
            ))}

            <div className="ws-card-actions">
              <button
                className="btn tiny"
                disabled={busyId === workspace.id}
                onClick={() =>
                  mutate(
                    workspace.id,
                    (cid) => updateWorkspace(cid, workspace.id, { enabled: !workspace.enabled }),
                    workspace.enabled ? '已禁用' : '已启用',
                  )
                }
              >
                {workspace.enabled ? '禁用' : '启用'}
              </button>
              <button
                className="btn tiny"
                onClick={() => {
                  setRename(workspace);
                  setRenameText(workspace.name);
                }}
              >
                重命名
              </button>
              <button className="btn tiny" onClick={() => openPicker({ mode: 'add-dir', workspaceId: workspace.id })}>
                ＋ 附加目录
              </button>
            </div>
          </div>
        ))
      )}

      {notice && <div className="ws-notice">{notice}</div>}

      {picker && (
        <DirectoryPickerDialog
          mode={picker.mode}
          workspacePaths={workspacePaths}
          busy={pickerBusy}
          error={pickerError}
          onClose={() => setPicker(null)}
          onPick={(path) => void pickDirectory(path)}
        />
      )}

      {rename && (
        <div className="modal-scrim" onClick={() => setRename(null)}>
          <div className="modal ws-rename" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>重命名工作区</span>
              <button className="btn ghost" title="关闭" onClick={() => setRename(null)}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="field">
              <label>名称</label>
              <input
                autoFocus
                value={renameText}
                maxLength={80}
                onChange={(event) => setRenameText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void confirmRename();
                }}
              />
            </div>
            <div className="perm-actions">
              <button className="btn primary" onClick={() => void confirmRename()}>
                保存
              </button>
              <button className="btn" onClick={() => setRename(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <div className="modal-scrim" onClick={() => setRemoving(null)}>
          <div className="modal ws-delete-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>删除工作区</span>
              <button className="btn ghost" title="关闭" onClick={() => setRemoving(null)}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <div>
              确定删除「{removing.name || removing.path}」吗？
              <div className="hint">只删除工作区本身，磁盘上的目录和文件不受影响。</div>
            </div>
            {removing.sessionCount > 0 && (
              <label className="switch">
                <input type="checkbox" checked={cascade} onChange={(event) => setCascade(event.target.checked)} />
                <span>
                  同时删除该工作区下的 {removing.sessionCount} 个会话。
                  聊天记录、运行事件与会话级授权一并删除；电脑上的 Claude Code 会话记录不受影响，
                  同一个目录重新加回来仍能续接。
                </span>
              </label>
            )}
            <div className="perm-actions">
              <button
                className="btn danger"
                disabled={removing.sessionCount > 0 && !cascade}
                onClick={() => void confirmDelete()}
              >
                删除
              </button>
              <button className="btn" onClick={() => setRemoving(null)}>
                取消
              </button>
            </div>
            {removing.sessionCount > 0 && !cascade && (
              <div className="hint">这个工作区还有会话，勾选「同时删除会话」后才能删。</div>
            )}
          </div>
        </div>
      )}

      <ContextMenu menu={menu} onClose={close} />
    </>
  );
}
