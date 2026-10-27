import { useEffect, useState } from 'react';
import { useAppearance } from '../../store/appearance';
import { FileBrowser, type FileMode, type FileSelection } from './FileBrowser';
import { FilePane } from './FilePane';
import { SPLIT_MIN_PX, type DiffView } from './DiffViewer';

/**
 * 右栏面板 (`desktop_ui_design.md` §6.8): the changed-files browser beside the
 * conversation. It always shows the live working-tree state; per-run diffs and
 * rollback are reached from the message bubbles, not from here.
 */
export function ChatAside({ workspaceId, onCollapse }: { workspaceId: string | null; onCollapse(): void }) {
  const width = useAppearance((state) => state.asideWidth);
  const setWidth = useAppearance((state) => state.setAsideWidth);
  const chatVisible = useAppearance((state) => state.chatVisible);
  const [mode, setMode] = useState<FileMode>('changes');
  const [root, setRoot] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  // 并排 only when the panel is wide enough; the panel defaults narrow, so the
  // fallback is unified.
  const [view, setView] = useState<DiffView>('unified');
  const canSplit = width >= SPLIT_MIN_PX;
  const effectiveView: DiffView = canSplit ? view : 'unified';

  // Root and open file are per-workspace; clear them when it changes so the
  // panel never shows another workspace's (or host's) state.
  useEffect(() => {
    setRoot(null);
    setSelection(null);
  }, [workspaceId]);

  /** Drag the left edge; the panel is anchored right, so width is the remainder. */
  function startResize(event: React.MouseEvent): void {
    event.preventDefault();
    const onMove = (move: MouseEvent): void => setWidth(window.innerWidth - move.clientX);
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    // With the conversation collapsed there is nothing to give width back to, so
    // the panel takes the whole remainder instead of its pinned width.
    <aside className={`chat-aside${chatVisible ? '' : ' fill'}`} style={chatVisible ? { width } : undefined}>
      {chatVisible && <div className="aside-resize" onMouseDown={startResize} title="拖拽调整宽度" />}
      <div className="aside-head">
        {selection ? (
          <>
            <button className="btn ghost tiny" onClick={() => setSelection(null)} title="回到列表">
              ← 列表
            </button>
            <span className="mono aside-path" title={selection.path}>
              {selection.path}
            </span>
          </>
        ) : (
          <span className="title">文件</span>
        )}
        {/* 并排/统一 stays reachable whether browsing the list or looking at one
            file, so a diff can be switched without going back first. Hidden for
            plain file content, which has no diff layout to choose. */}
        {(!selection || selection.kind === 'diff') && (
          <span className="seg3">
            <button
              className={effectiveView === 'split' ? 'active' : ''}
              title={canSplit ? '并排显示' : '并排显示（会先把右栏拉宽到可读宽度）'}
              onClick={() => {
                // A too-narrow panel would render 并排 unreadably, so widen it first.
                if (!canSplit) setWidth(SPLIT_MIN_PX);
                setView('split');
              }}
            >
              并排
            </button>
            <button className={effectiveView === 'unified' ? 'active' : ''} onClick={() => setView('unified')}>
              统一
            </button>
          </span>
        )}
        <button className="btn ghost tiny aside-close" onClick={onCollapse} title="收起右栏">
          ✕
        </button>
      </div>

      <div className="aside-body">
        {selection ? (
          <FilePane
            workspaceId={workspaceId}
            root={root}
            selection={selection}
            view={effectiveView}
            narrowHint={!canSplit}
            emptyText=""
          />
        ) : (
          <FileBrowser
            workspaceId={workspaceId}
            root={root}
            onRootChange={setRoot}
            mode={mode}
            onModeChange={setMode}
            selectedPath={null}
            onSelect={setSelection}
            diffView={effectiveView}
          />
        )}
      </div>
    </aside>
  );
}
