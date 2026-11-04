import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../../store/connection';
import { useAppearance } from '../../store/appearance';
import { FileBrowser, type FileMode, type FileSelection } from './FileBrowser';
import { FilePane } from './FilePane';

/** The directory column's fixed share once the panel is wide enough for two. */
const TREE_COL_PX = 200;

/**
 * Panel width at which the two-level split is worth it: 200 of list plus at
 * least 480 of code. Below that the panel is a drill-down. (The old threshold
 * was 520, which left the diff with 320 and clipped every line; the diff's own
 * 640 threshold was also measured against the whole panel, ignoring the 200 the
 * tree takes.)
 */
const SPLIT_ASIDE_PX = 680;

interface AsideSnapshot {
  /** Host + workspace: another host/workspace must not inherit paths. */
  key: string;
  mode: FileMode;
  root: string | null;
  selection: FileSelection | null;
}

/**
 * The panel unmounts when it is closed, so its last state lives here. Reopening
 * restores the mode, root and open file; a different host or workspace has a
 * different key and starts at 改动 again.
 */
let lastAside: AsideSnapshot | null = null;

/**
 * The chat's right panel (`desktop_ui_design.md` §6.8).
 *
 * Two shapes, decided by width rather than a mode switch:
 * - **drill-down** (default at any width): the list fills the panel; opening a
 *   file replaces it and `←` comes back. This is the shape that works at the
 *   default window size, where a fourth column cannot fit.
 * - **split** (panel ≥ 680): the list keeps a 200px column beside the viewer, so
 *   switching files is one click.
 *
 * There is no panel-wide header: each half carries its own controls (mode and
 * refresh on the list; path, view and close on the viewer). A separate 44px bar
 * above both only ever held the close button and added a third row of chrome.
 */
export function ChatAside({
  workspaceId,
  onCollapse,
  maxWidth,
}: {
  workspaceId: string | null;
  onCollapse(): void;
  /** Width cap from the shell, so the chat always keeps its floor. */
  maxWidth: number;
}) {
  const width = useAppearance((state) => state.asideWidth);
  const setWidth = useAppearance((state) => state.setAsideWidth);
  const chatVisible = useAppearance((state) => state.chatVisible);
  const connectionId = useConnection((state) => state.activeId);
  const panelKey = `${connectionId ?? ''}:${workspaceId ?? ''}`;
  const restored = lastAside?.key === panelKey ? lastAside : null;
  const [mode, setMode] = useState<FileMode>(restored?.mode ?? 'changes');
  const [root, setRoot] = useState<string | null>(restored?.root ?? null);
  const [selection, setSelection] = useState<FileSelection | null>(restored?.selection ?? null);
  // Persisted display preference (appearance store), not panel state: closing
  // and reopening the panel keeps the diff mode the reader picked.
  const view = useAppearance((state) => state.diffView);
  const setView = useAppearance((state) => state.setDiffView);

  /*
   * Measure the panel instead of trusting `asideWidth`: with the conversation
   * collapsed the panel is `.fill` and occupies the whole remainder, so the
   * persisted width (420) says nothing about how much room the two-level layout
   * actually has. A ResizeObserver also catches rail/window changes.
   */
  const asideRef = useRef<HTMLElement>(null);
  const [actualWidth, setActualWidth] = useState(0);
  useEffect(() => {
    const element = asideRef.current;
    if (!element) return;
    const measure = (): void => setActualWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const renderedWidth = Math.min(width, maxWidth);
  const split = selection !== null && actualWidth >= SPLIT_ASIDE_PX;

  // A workspace switch resets the panel (mode included); the mount itself must
  // not, or reopening would wipe the state restored from `lastAside`.
  const mountedWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (mountedWorkspace.current === workspaceId) return;
    mountedWorkspace.current = workspaceId;
    setMode('changes');
    setRoot(null);
    setSelection(null);
  }, [workspaceId]);

  // Write-through for the next mount. Closing the panel does not run a cleanup,
  // so this has to mirror every committed state.
  useEffect(() => {
    lastAside = { key: panelKey, mode, root, selection };
  }, [panelKey, mode, root, selection]);

  function openFile(next: FileSelection): void {
    setSelection(next);
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
    const onMove = (move: MouseEvent): void => {
      // Stop at the shell's floor instead of persisting a width that will be
      // clamped on the next render anyway.
      setWidth(Math.min(window.innerWidth - move.clientX, maxWidth));
    };
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
    <aside
      ref={asideRef}
      className={`chat-aside${chatVisible ? '' : ' fill'}`}
      style={chatVisible ? { width: renderedWidth } : undefined}
    >
      {chatVisible && <div className="aside-resize" onMouseDown={startResize} title="拖拽调整宽度" />}
      <div className={`aside-body${split ? ' split' : ''}`}>
        {/* Hidden, not unmounted, while a file fills the panel: the list keeps its
            scroll, its expanded directories and its listing cache for the way back. */}
        <div
          className={`aside-tree-col${selection !== null && !split ? ' hidden' : ''}`}
          style={split ? { flex: `0 0 ${TREE_COL_PX}px` } : undefined}
        >
          <FileBrowser
            compact={split}
            workspaceId={workspaceId}
            root={root}
            onRootChange={changeRoot}
            mode={mode}
            onModeChange={changeMode}
            selectedPath={selection?.path ?? null}
            onSelect={openFile}
            onDirectoryChange={clearFile}
            onClose={selection === null ? onCollapse : undefined}
          />
        </div>
        {selection !== null ? (
          <div className="aside-pane-col">
            <FilePane
              workspaceId={workspaceId}
              root={root}
              selection={selection}
              view={view}
              onViewChange={setView}
              onBack={clearFile}
              onClose={onCollapse}
            />
          </div>
        ) : null}
      </div>
    </aside>
  );
}
