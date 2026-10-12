import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeToolGroup, segmentBlocks, toolGroupStatus, toolSummary } from './segments';
import { Markdown } from './Markdown';
import { QuestionBlock } from './QuestionBlock';
import { useToolGroups } from './toolGroups';
import { ToolIcon } from '../../ui/ToolIcon';
import { formatTokens } from '../../../../shared/format';
import type { RunDto } from '../../../../shared/contract';
import type { ChatMessage, ContentBlock, UsageInfo } from '../../store/chat/types';
import { canRollbackRun } from './runActions';

type ToolBlock = Extract<ContentBlock, { kind: 'tool' }>;

const VISIBLE = 80;
const PAGE = 40;
/** Distance from the top that triggers loading the previous page. */
const REVEAL_AT_PX = 48;

/**
 * The message list.
 *
 * Only the most recent window stays mounted (docs/local/pages/chat.md §6.3:
 * "虚拟化历史、保留最近 N 条始终挂载"). Scrolling to the top pulls in more,
 * which is what makes scrolling back through a long session feel continuous
 * without a measurement-based virtualizer.
 *
 * Windowing the loaded head would need dynamic height measurement, and with the
 * transcript anchored at the bottom that is exactly the combination that makes
 * the scrollbar jump per frame — the risk the spec calls out. Capping what is
 * mounted gets the memory/layout win without that failure mode.
 */
export function Transcript({
  messages,
  scrollRef,
  runs,
  onRollback,
}: {
  messages: ChatMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The session's runs, to gate the per-message rollback action by checkpoint. */
  runs: RunDto[];
  onRollback(runId: string): void;
}) {
  const [limit, setLimit] = useState(VISIBLE);
  const shown = messages.length > limit ? messages.slice(messages.length - limit) : messages;
  const hidden = messages.length - shown.length;

  // Reveal more as the user reaches the top. Prepending shifts everything
  // down, so the row the reader is looking at has to be pinned back to where it
  // was — otherwise loading history yanks the text out from under them.
  const anchor = useRef<{ id: string; top: number } | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const pinned = anchor.current;
    if (!scroller || !pinned) return;
    anchor.current = null;
    const row = scroller.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(pinned.id)}"]`);
    if (!row) return;
    const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - pinned.top;
  }, [limit, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const capture = (): void => {
      const base = scroller.getBoundingClientRect().top;
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-msg-id]')) {
        const top = row.getBoundingClientRect().top - base;
        if (top >= 0) {
          anchor.current = { id: row.dataset['msgId'] ?? '', top };
          return;
        }
      }
    };
    const onScroll = (): void => {
      if (scroller.scrollTop > REVEAL_AT_PX || hidden === 0) return;
      capture();
      setLimit((value) => value + PAGE);
    };
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scrollRef, hidden]);

  return (
    <div className="transcript">
      {hidden > 0 && (
        <button className="btn ghost load-earlier" onClick={() => setLimit((value) => value + PAGE)}>
          显示更早的 {hidden} 条
        </button>
      )}
      {shown.map((message) =>
        message.kind === 'user' ? (
          <UserRow
            key={message.id}
            id={message.id}
            text={message.text}
            run={message.runId ? runs.find((r) => r.id === message.runId) : undefined}
            onRollback={onRollback}
          />
        ) : (
          <AssistantRow key={message.id} message={message} />
        ),
      )}
    </div>
  );
}

/** Hover-revealed copy affordance, in place of the mobile long-press. */
function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      className={`icon-btn copy ${className}`}
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function UserRow({
  id,
  text,
  run,
  onRollback,
}: {
  id: string;
  text: string;
  run: RunDto | undefined;
  onRollback(runId: string): void;
}) {
  return (
    <div className="msg user" data-msg-id={id}>
      <div className="bubble">{text}</div>
      <div className="msg-actions">
        <CopyButton text={text} />
        {run && canRollbackRun(run) && (
          <button
            className="btn ghost tiny"
            title="把工作区文件恢复到这次发送之前（破坏性，agent 对话不回退）"
            onClick={() => onRollback(run.id)}
          >
            回滚
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantRow({ message }: { message: Extract<ChatMessage, { kind: 'assistant' }> }) {
  const id = message.id;
  const segments = segmentBlocks(message.blocks);
  const text = message.blocks
    .filter((block): block is Extract<ContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('\n\n');

  return (
    <div className="msg assistant" data-msg-id={id}>
      {text && (
        <div className="msg-actions">
          <CopyButton text={text} />
        </div>
      )}

      {segments.map((segment, index) => {
        switch (segment.kind) {
          case 'text':
            return <Markdown key={index} text={segment.text} />;
          case 'thinking':
            return <ThinkingBlock key={index} text={segment.text} />;
          case 'question':
            return (
              <QuestionBlock
                key={index}
                toolUseId={segment.toolUseId}
                questions={segment.questions}
                answered={segment.answered}
              />
            );
          case 'tools':
            return <ToolGroup key={segment.key} tools={segment.tools} />;
        }
      })}

      {message.usage && <UsageRow usage={message.usage} />}
      {message.error && <div className="msg-error">{message.error}</div>}
      {!message.done && <div className="msg-pending">● 正在执行…</div>}
    </div>
  );
}

/**
 * Folds usually collapse: the folded line and the thinking line are the same
 * height so a mixed turn does not produce a ragged column
 * (docs/local/pages/chat.md §6.3).
 */
function FoldRow({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle(): void;
  label: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <>
      <button className="fold-head" aria-expanded={open} onClick={onToggle}>
        <span className="chevron">▶</span>
        {label}
      </button>
      {children}
    </>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="block-thinking">
      <FoldRow open={open} onToggle={() => setOpen((value) => !value)} label={<span>思考</span>} />
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

/**
 * Consecutive tool calls, folded to one line. One agent turn often makes dozens
 * of calls; showing a card each would push the actual answer off screen.
 */
function ToolGroup({ tools }: { tools: ToolBlock[] }) {
  const all = useToolGroups((state) => state.all);
  const revision = useToolGroups((state) => state.revision);
  const [local, setLocal] = useState<boolean | null>(null);

  // A global toggle discards per-group overrides.
  useEffect(() => {
    setLocal(null);
  }, [revision]);

  const open = local ?? all ?? false;
  const status = toolGroupStatus(tools);
  const summary = toolGroupStatusSummary(status);

  return (
    <div className="tool-group">
      <FoldRow
        open={open}
        onToggle={() => setLocal(!open)}
        label={
          <span className="tool-group-label" title={summary || undefined}>
            <span className="tool-group-desc">{describeToolGroup(tools)}</span>
            {summary && <span className="tool-group-status">{summary}</span>}
          </span>
        }
      />
      {open && (
        <div className="tool-list">
          {tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function toolGroupStatusSummary(status: { running: number; failed: number; interrupted: number }): string {
  const parts: string[] = [];
  if (status.running) parts.push(`${status.running} 个运行中`);
  if (status.failed) parts.push(`${status.failed} 个失败`);
  if (status.interrupted) parts.push(`${status.interrupted} 个中断`);
  return parts.join(' · ');
}

function ToolCard({ tool }: { tool: ToolBlock }) {
  const state = tool.running ? 'running' : tool.isError ? 'error' : tool.interrupted ? 'interrupted' : 'done';
  const summary = toolSummary(tool.input);
  return (
    <details className={`tool-card ${state}`}>
      <summary>
        <ToolIcon name={tool.name} />
        <span className="mono tool-name">{tool.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-state">{STATE_LABEL[state]}</span>
        <CopyButton text={JSON.stringify(tool.input, null, 2)} className="tool-copy" />
      </summary>
      <pre className="mono tool-io">{JSON.stringify(tool.input, null, 2)}</pre>
      {tool.result !== null && <pre className="mono tool-io result">{tool.result}</pre>}
    </details>
  );
}

/**
 * Tokens and cost for the turn. No occupancy bar: the per-message frame carries
 * no context-window size, and the session's current occupancy is a different
 * number — a bar here would be a guess dressed as a measurement. The header
 * ring already covers "how full am I".
 */
function UsageRow({ usage }: { usage: UsageInfo }) {
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`▲ ${formatTokens(usage.inputTokens)}`);
  if (usage.outputTokens !== null) parts.push(`▼ ${formatTokens(usage.outputTokens)}`);
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(3)}`);
  if (parts.length === 0) return null;
  return (
    <div className="usage">
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  running: '运行中…',
  error: '失败',
  interrupted: '已中断',
  done: '完成',
};
