import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeToolGroup, segmentBlocks, toolGroupStatus, toolSummary } from './segments';
import { conversationSegments, hasTraceSegments, questionInteractive } from './conversationSegments';
import { splitSummonLines } from './summonLines';
import { Markdown } from './Markdown';
import { QuestionBlock } from './QuestionBlock';
import { useToolGroups } from './toolGroups';
import { ToolIcon } from '../../ui/ToolIcon';
import { Icon } from '../../ui/Icon';
import { formatMessageTime, formatTokens } from '../../../../shared/format';
import type { RunDto } from '../../../../shared/contract';
import type { ChatMessage, ContentBlock, UsageInfo } from '../../store/chat/types';
import { AttachmentThumbs } from './AttachmentThumbs';

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
  agentNames,
  showSpeakerName = true,
  leaderAgentId = null,
  onOpenTrace,
}: {
  messages: ChatMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The session's runs, so a question can be matched to the run that answered it. */
  runs: RunDto[];
  /** agentId → name, used for labels, avatars and summon parsing. */
  agentNames?: Map<string, string>;
  /** Hide the speaker name in a single-assistant session. */
  showSpeakerName?: boolean;
  /** Only the leader's line-start @lines become summon bubbles. */
  leaderAgentId?: string | null;
  /** Open the full thinking/tool trace for a completed answer. */
  onOpenTrace?(runId: string): void;
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

  // A question card is answerable only while it answers the latest user turn.
  const lastUserIndex = messages.reduce(
    (last, message, index) => (message.kind === 'user' ? index : last),
    -1,
  );
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const lastUserTurnId = lastUser?.kind === 'user' ? (lastUser.turnId ?? null) : null;
  const offset = messages.length - shown.length;

  return (
    <div className="transcript">
      {hidden > 0 && (
        <button className="btn ghost load-earlier" onClick={() => setLimit((value) => value + PAGE)}>
          显示更早的 {hidden} 条
        </button>
      )}
      {shown.map((message, index) => {
        if (message.kind === 'user') {
          return (
            <UserRow
              key={message.id}
              id={message.id}
              text={message.text}
              attachmentIds={message.attachmentIds}
              at={message.at}
            />
          );
        }
        const run = message.runId ? runs.find((r) => r.id === message.runId) : undefined;
        return (
          <AssistantRow
            key={message.id}
            message={message}
            agentNames={agentNames}
            showSpeakerName={showSpeakerName}
            leaderAgentId={leaderAgentId}
            textOnly
            interactive={questionInteractive({
              index: offset + index,
              lastUserIndex,
              runTurnId: run?.turnId ?? null,
              lastUserTurnId,
            })}
            onOpenTrace={onOpenTrace}
          />
        );
      })}
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
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

function UserRow({
  id,
  text,
  attachmentIds,
  at,
}: {
  id: string;
  text: string;
  attachmentIds?: string[];
  at: number | undefined;
}) {
  const sentAt =
    at === undefined || !Number.isFinite(at) || at <= 0
      ? null
      : { label: formatMessageTime(at), iso: new Date(at).toISOString() };
  return (
    <div className="msg user" data-msg-id={id}>
      <div className="user-stack">
        {attachmentIds && attachmentIds.length > 0 && (
          <AttachmentThumbs ids={attachmentIds} />
        )}
        <div className="bubble">{text}</div>
        {sentAt && (
          <time className="msg-time" dateTime={sentAt.iso}>
            {sentAt.label}
          </time>
        )}
      </div>
      <div className="msg-actions">
        <CopyButton text={text} />
      </div>
    </div>
  );
}

export function AssistantRow({
  message,
  agentNames,
  showSpeakerName = true,
  leaderAgentId = null,
  textOnly = false,
  interactive = true,
  onOpenTrace,
}: {
  message: Extract<ChatMessage, { kind: 'assistant' }>;
  agentNames?: Map<string, string>;
  showSpeakerName?: boolean;
  leaderAgentId?: string | null;
  /** Conversation view: final text only; tool/thinking detail lives in 助手. */
  textOnly?: boolean;
  /** False for a static trace/historical view where answering is not possible. */
  interactive?: boolean;
  onOpenTrace?(runId: string): void;
}) {
  const id = message.id;
  const segments = segmentBlocks(message.blocks);
  const text = message.blocks
    .filter((block): block is Extract<ContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('\n\n');
  const visibleSegments = textOnly ? conversationSegments(message.blocks) : segments;
  const hasTrace = hasTraceSegments(message.blocks);
  const speaker =
    message.agentName ?? (message.agentId ? agentNames?.get(message.agentId) : undefined);
  const memberNames = agentNames ? [...agentNames.values()] : [];
  const split =
    textOnly && message.agentId === leaderAgentId
      ? splitSummonLines(text, memberNames)
      : { body: text, summons: [] as string[] };
  const nonTextSegments = visibleSegments.filter((segment) => segment.kind !== 'text');
  const hasVisibleContent =
    split.body.trim() !== '' ||
    nonTextSegments.length > 0 ||
    Boolean(message.error);
  const showMainRow =
    hasVisibleContent ||
    (textOnly &&
      message.runId &&
      (hasTrace || (message.done && split.summons.length === 0)));
  /**
   * An ask is inert once the daemon settled it (`answerStatus`) or once a
   * blocking ask's run ended (the permission id is dead). A headless-runtime
   * ask has no permission id: its answer is a continuation turn, so it stays
   * open for the turn it belongs to.
   */
  const questionClosed = (segment: {
    permissionId?: string | null;
    answered: boolean;
    answerStatus?: 'allowed' | 'denied' | 'timed_out' | null;
  }): boolean =>
    Boolean(segment.answerStatus) ||
    (Boolean(segment.permissionId) && message.done && !segment.answered);
  const avatarText = (speaker ?? 'AI').trim().slice(0, 1).toUpperCase() || 'AI';
  const avatarColor = agentColor(message.agentId ?? speaker ?? 'AI');

  if (textOnly) {
    return (
      <>
        {showMainRow && (
          <div className="msg assistant chat-message" data-msg-id={id}>
            {/* Single-agent chats have no one to tell apart: the avatar would
                only inset the answer from the composer's column. */}
            {showSpeakerName && (
              <div className="msg-avatar" style={{ background: avatarColor }} aria-hidden="true">
                {avatarText}
              </div>
            )}
            <div className="assistant-body">
              {showSpeakerName && speaker && (
                <div className="msg-speaker">
                  <span className="msg-speaker-dot" style={{ background: avatarColor }} />
                  {speaker}
                </div>
              )}
              <div className="assistant-bubble">
                {split.body && <Markdown text={split.body} />}
                {nonTextSegments.map((segment, index) => {
                  switch (segment.kind) {
                    case 'question':
                      return (
                        <QuestionBlock
                          key={index}
                          toolUseId={segment.toolUseId}
                          questions={segment.questions}
                          answered={segment.answered}
                          answerStatus={segment.answerStatus ?? null}
                          answers={segment.answers ?? null}
                          answerText={segment.answerText ?? null}
                          permissionId={segment.permissionId}
                          interactive={interactive}
                          closed={questionClosed(segment)}
                        />
                      );
                    case 'notice':
                      return (
                        <div key={index} className="chat-notice">
                          {segment.text}
                        </div>
                      );
                    default:
                      return null;
                  }
                })}
                {message.error && <div className="msg-error">{message.error}</div>}
                {!hasVisibleContent && (
                  <div className="hint">
                    {hasTrace
                      ? '这条回答没有可见文本，点击「查看过程」查看工具调用。'
                      : '这次回答没有可见输出。'}
                  </div>
                )}
              </div>
              <div className="msg-actions assistant-actions">
                {split.body && <CopyButton text={split.body} />}
                {message.runId && hasTrace && (
                  <button
                    className="btn ghost tiny"
                    title="查看这次回答的思考和工具调用"
                    onClick={() => onOpenTrace?.(message.runId!)}
                  >
                    查看过程
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {split.summons.map((line, index) => (
          <div className="msg assistant chat-message summon-message" key={`${id}-summon-${index}`}>
            {showSpeakerName && (
              <div className="msg-avatar" style={{ background: avatarColor }} aria-hidden="true">
                {avatarText}
              </div>
            )}
            <div className="assistant-body">
              {showSpeakerName && speaker && (
                <div className="msg-speaker">
                  <span className="msg-speaker-dot" style={{ background: avatarColor }} />
                  {speaker}
                </div>
              )}
              <div className="assistant-bubble summon-bubble">
                <Markdown text={line} />
              </div>
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="msg assistant" data-msg-id={id}>
      {speaker && (
        <div className="msg-speaker">
          <span className="msg-speaker-dot" style={{ background: avatarColor }} />
          {speaker}
        </div>
      )}
      {hasVisibleContent && (
        <div className="msg-actions">{text && <CopyButton text={text} />}</div>
      )}

      {segments.map((segment, index) => {
        switch (segment.kind) {
          case 'text':
            return <Markdown key={index} text={segment.text} />;
          case 'thinking':
            return <ThinkingBlock key={index} active={segment.active} />;
          case 'question':
            return (
              <QuestionBlock
                key={index}
                toolUseId={segment.toolUseId}
                questions={segment.questions}
                answered={segment.answered}
                answerStatus={segment.answerStatus ?? null}
                answers={segment.answers ?? null}
                answerText={segment.answerText ?? null}
                permissionId={segment.permissionId}
                interactive={interactive}
                closed={questionClosed(segment)}
              />
            );
          case 'notice':
            return (
              <div key={index} className="chat-notice">
                {segment.text}
              </div>
            );
          case 'tools':
            return <ToolGroup key={segment.key} tools={segment.tools} />;
        }
      })}
      {message.usage && <UsageRow usage={message.usage} />}
      {message.error && <div className="msg-error">{message.error}</div>}
      {!hasVisibleContent && <div className="hint">这次运行没有可见输出。</div>}
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
        <span className="chevron">
          <Icon name="chevron-right" size={12} />
        </span>
        {label}
      </button>
      {children}
    </>
  );
}

/**
 * Thinking content is never sent, so there is nothing to show but its state. It
 * used to render a full bordered card with an empty body — four of those in a
 * row read as four broken panels. A single quiet line says the same thing and
 * costs one row instead of a card.
 */
function ThinkingBlock({ active }: { active: boolean }) {
  return (
    <div className={`think-line${active ? ' active' : ''}`}>
      {active && (
        <span className="think-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span>{active ? '思考中' : '思考'}</span>
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

/**
 * 稳定散布色：同一个助手在任何界面都是同一个颜色。
 *
 * 按 id 散列而不是名字 —— 改名不该换颜色，否则用户会以为是另一个人。
 * 与 Android / iOS 用同一套调色板与算法，三端颜色一致。
 */
const AGENT_PALETTE = ['#5B8DEF', '#14B8A6', '#F59E0B', '#EC4899', '#8B5CF6', '#10B981'];

function agentColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)!) & 0x7fffffff;
  return AGENT_PALETTE[hash % AGENT_PALETTE.length]!;
}
