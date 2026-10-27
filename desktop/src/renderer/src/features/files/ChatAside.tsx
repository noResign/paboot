import { useEffect, useRef, useState } from 'react';
import { useAppearance } from '../../store/appearance';
import { FileBrowser, type FileMode, type FileSelection } from './FileBrowser';
import { FilePane } from './FilePane';
import { SPLIT_MIN_PX, type DiffView } from './DiffViewer';

/** Enough for a readable tree column plus a diff; narrower and the split hurts. */
const TREE_MIN_ASIDE_PX = 520;

/**
 * 右栏面板 (`desktop_ui_design.md` §6.8): a directory column beside the file
 * viewer. The list stays mounted across selection changes so the tree, expanded
 * folders and scroll position survive; opening a file only swaps the right half.
 * The directory column can be collapsed, and the whole panel is resizable.
 */
export function ChatAside({ workspaceId, onCollapse }: { workspaceId: string | null; onCollapse(): void }) {
  const width = useAppearance((state) => state.asideWidth);
  const setWidth = useAppearance((state) => state.setAsideWidth);
  const chatVisible = useAppearance((state) => state.chatVisible);
  const treeVisible = useAppearance((state) => state.asideTreeVisible);
  const toggleTree = useAppearance((state) => state.toggleAsideTree);
  const [mode, setMode] = useState<FileMode>('changes');
  const [root, setRoot] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  /** Keep the two-column shape while browsing after a file was opened. */
  const [splitActive, setSplitActive] = useState(false);
  // 并排 only when the panel is wide enough; the panel defaults narrow, so the
  // fallback is unified.
  const [view, setView] = useState<DiffView>('unified');
  const canSplitDiff = width >= SPLIT_MIN_PX;
  const effectiveView: DiffView = canSplitDiff ? view : 'unified';
  /** Widen once for the first file so the two columns are readable; respect a
   *  width the user picks afterwards. */
  const autoWidened = useRef(false);

  // Root, mode and open file are scoped to the workspace/listing; clear them so
  // the panel never shows another workspace's (or directory's) state.
  useEffect(() => {
    setRoot(null);
    setSelection(null);
    setSplitActive(false);
    autoWidened.current = false;
  }, [workspaceId]);

  function openFile(next: FileSelection): void {
    setSplitActive(true);
    setSelection(next);
    if (treeVisible && !autoWidened.current && width < TREE_MIN_ASIDE_PX) {
      autoWidened.current = true;
      setWidth(TREE_MIN_ASIDE_PX);
    }
  }

  /** The right half must not keep a file from the previous listing. */
  function clearFile(): void {
    setSelection(null);
  }

  function changeMode(next: FileMode): void {
    if (next === mode) return;
    setMode(next);
    clearFile();
  }

  function changeRoot(next: string): void {
    if (next === root) return;
    setRoot(next);
    clearFile();
  }

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
        {splitActive ? (
          <>
            <button
              className="btn ghost tiny"
              onClick={() => {
                setSplitActive(false);
                clearFile();
              }}
              title="回到完整文件列表"
            >
              ←
            </button>
            <button
              className={`btn ghost tiny${treeVisible ? ' active' : ''}`}
              title={treeVisible ? '收起目录栏' : '展开目录栏'}
              onClick={toggleTree}
            >
              目录
            </button>
            {selection?.kind === 'diff' && (
              <span className="seg3">
                <button
                  className={effectiveView === 'split' ? 'active' : ''}
                  title={canSplitDiff ? '并排显示' : '并排显示（会先把右栏拉宽到可读宽度）'}
                  onClick={() => {
                    // A too-narrow panel would render 并排 unreadably, so widen it first.
                    if (!canSplitDiff) setWidth(SPLIT_MIN_PX);
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
          </>
        ) : (
          <span className="title">文件</span>
        )}
        <button className="btn ghost tiny aside-close" onClick={onCollapse} title="收起右栏">
          ✕
        </button>
      </div>

      <div className={`aside-body${splitActive ? ' split' : ''}`}>
        <div className={`aside-tree-col${splitActive && !treeVisible ? ' hidden' : ''}`}>
          <FileBrowser
            compact={splitActive}
            workspaceId={workspaceId}
            root={root}
            onRootChange={changeRoot}
            mode={mode}
            onModeChange={changeMode}
            selectedPath={selection?.path ?? null}
            onSelect={openFile}
            onDirectoryChange={clearFile}
          />
        </div>
        {splitActive && (
          <div className="aside-pane-col">
            {selection ? (
              <FilePane
                workspaceId={workspaceId}
                root={root}
                selection={selection}
                view={effectiveView}
                narrowHint={!canSplitDiff}
                emptyText=""
              />
            ) : (
              <div className="aside-empty">从左侧选择一个文件，查看内容或改动。</div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
