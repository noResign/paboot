import { useEffect, useState } from 'react';
import { useAppearance } from '../../store/appearance';
import { useChat } from '../../store/chat';
import { RunList } from '../chat/RunList';
import { FileBrowser, type FileMode, type FileSelection } from './FileBrowser';
import { FilePane } from './FilePane';

type AsideTab = 'files' | 'runs';

/**
 * 右栏面板 (`desktop_ui_design.md` §2 / §6.8): the changed-files browser and the
 * run history beside the conversation. The files half can be scoped to a single
 * run's checkpoint diff; the run half lists every run with per-run actions.
 */
export function ChatAside({ workspaceId, onCollapse }: { workspaceId: string | null; onCollapse(): void }) {
  const width = useAppearance((state) => state.asideWidth);
  const setWidth = useAppearance((state) => state.setAsideWidth);
  const chatVisible = useAppearance((state) => state.chatVisible);
  const [tab, setTab] = useState<AsideTab>('files');
  const [mode, setMode] = useState<FileMode>('changes');
  const [root, setRoot] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  // Files scope: an explicitly picked run (from the run list) or the latest
  // settled run (the 本轮 button). `null` = live dirty state.
  const [runId, setRunId] = useState<string | null>(null);
  const chat = useChat((state) => (state.activeKey ? state.byKey[state.activeKey] : undefined));
  const latestRunId = chat && chat.phase === 'settled' ? (chat.runId ?? null) : null;

  // Root, scope and open file are per-workspace; clear them when it changes so
  // the panel never shows another workspace's (or host's) state.
  useEffect(() => {
    setRoot(null);
    setSelection(null);
    setRunId(null);
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
          <>
            <button
              className={`btn ghost tiny${tab === 'files' ? ' active' : ''}`}
              onClick={() => setTab('files')}
            >
              文件
            </button>
            <button
              className={`btn ghost tiny${tab === 'runs' ? ' active' : ''}`}
              onClick={() => {
                setTab('runs');
                setSelection(null);
              }}
            >
              运行
            </button>
            {tab === 'files' &&
              (runId ? (
                <button
                  className="btn ghost tiny active"
                  title="当前只显示该轮运行的改动；点击恢复工作区实时改动"
                  onClick={() => setRunId(null)}
                >
                  仅该轮 ✕
                </button>
              ) : (
                latestRunId && (
                  <button
                    className="btn ghost tiny"
                    title="只看最近一轮运行的改动"
                    onClick={() => setRunId(latestRunId)}
                  >
                    本轮
                  </button>
                )
              ))}
          </>
        )}
        <button className="btn ghost tiny aside-close" onClick={onCollapse} title="收起右栏">
          ✕
        </button>
      </div>

      <div className="aside-body">
        {tab === 'runs' ? (
          <RunList
            runs={chat?.runs ?? []}
            connectionId={chat?.connectionId ?? ''}
            sessionId={chat?.sessionId ?? null}
            onViewChanges={(picked) => {
              setRunId(picked);
              setSelection(null);
              setTab('files');
            }}
          />
        ) : selection ? (
          // Always unified here: the panel is far narrower than the split minimum.
          <FilePane
            workspaceId={workspaceId}
            root={root}
            selection={selection}
            view="unified"
            emptyText=""
            runId={runId ?? undefined}
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
            runId={runId ?? undefined}
          />
        )}
      </div>
    </aside>
  );
}
