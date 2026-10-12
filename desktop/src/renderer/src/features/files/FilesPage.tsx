import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppearance } from '../../store/appearance';
import { FileBrowser, type FileMode, type FileSelection } from './FileBrowser';
import { FilePane } from './FilePane';
import { SPLIT_MIN_PX, type DiffView } from './DiffViewer';

/**
 * Below this pane width the side-by-side view degrades to unified. Sized so the
 * default window (1280 − 300 rail − 260 tree = 720) keeps 并排 available; it only
 * kicks in once the window is genuinely cramped.
 */

/**
 * ⑤ 文件 / ⑥ Diff (docs/local/pages/files.md §6.8). The desktop-only move is
 * 同屏两级分栏: the phone pushes a page per file because it has no width for
 * a tree next to a viewer, and that side-by-side is the main reason this view
 * exists at all.
 */
export function FilesPage({ workspaceId, workspaceName }: { workspaceId: string | null; workspaceName: string | null }) {
  const treeVisible = useAppearance((state) => state.fileTreeVisible);
  const toggleFileTree = useAppearance((state) => state.toggleFileTree);

  const [mode, setMode] = useState<FileMode>('changes');
  const [root, setRoot] = useState<string | null>(null);
  const [view, setView] = useState<DiffView>('split');
  const [selection, setSelection] = useState<FileSelection | null>(null);

  const paneRef = useRef<HTMLDivElement>(null);
  const canSplit = useElementWidth(paneRef) >= SPLIT_MIN_PX;
  const effectiveView: DiffView = canSplit ? view : 'unified';

  // The tree root and the open file belong to one workspace; drop them when the
  // workspace (or host) changes so nothing from the previous one lingers.
  useEffect(() => {
    setRoot(null);
    setSelection(null);
  }, [workspaceId]);

  return (
    <div className="files">
      <div className="files-head">
        <span className="title">文件</span>
        <span className="hint" style={{ margin: 0 }}>
          {workspaceName ?? '工作区'}
        </span>
        <div className="files-head-actions">
          <button
            className="btn tiny"
            title={treeVisible ? '收起左侧列表，只看文件内容' : '展开左侧列表'}
            onClick={toggleFileTree}
          >
            {treeVisible ? '⇤ 收起列表' : '⇥ 展开列表'}
          </button>
          <div className="seg3">
            <button
              className={effectiveView === 'split' ? 'active' : ''}
              disabled={!canSplit}
              title={canSplit ? '并排显示' : '窗口偏窄，已自动用统一视图'}
              onClick={() => setView('split')}
            >
              并排
            </button>
            <button className={effectiveView === 'unified' ? 'active' : ''} onClick={() => setView('unified')}>
              统一
            </button>
          </div>
        </div>
      </div>

      <div className={`files-split${treeVisible ? '' : ' tree-hidden'}`}>
        <FileBrowser
          workspaceId={workspaceId}
          root={root}
          onRootChange={setRoot}
          mode={mode}
          onModeChange={setMode}
          selectedPath={selection?.path ?? null}
          onSelect={setSelection}
          diffView={effectiveView}
        />
        <div ref={paneRef} className="fpane-host">
          <FilePane
            workspaceId={workspaceId}
            root={root}
            selection={selection}
            view={effectiveView}
            narrowHint={!canSplit}
            emptyText="左侧选一个文件，这里显示它的内容或改动。"
          />
        </div>
      </div>
    </div>
  );
}

/** Element width via ResizeObserver — drives the split→unified degradation. */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
