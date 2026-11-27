import { hasUnansweredQuestion } from './conversationSegments';
import type { ChatMessage, ChatSessionState, ContentBlock } from '../../store/chat/types';

/** What a live answer is doing right now, for the status strip. */
export type AgentActivityKind = 'thinking' | 'tool' | 'writing' | 'answering';

export interface AgentActivity {
  runId: string;
  agentId: string | null;
  kind: AgentActivityKind;
  /** Tool name while `kind === 'tool'`. */
  toolName?: string;
}

/** Read the current activity off a live message's blocks (last active wins). */
export function activityOf(blocks: readonly ContentBlock[]): {
  kind: AgentActivityKind;
  toolName?: string;
} {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'tool' && block.running) return { kind: 'tool', toolName: block.name };
    if (block.kind === 'thinking' && block.active) return { kind: 'thinking' };
    // A text block is only present while the run is still writing it: when it
    // is the newest block, the agent is producing output.
    if (block.kind === 'text') return { kind: 'writing' };
    // Finished tool / settled thinking / notice: keep looking further back.
  }
  return { kind: 'answering' };
}

/**
 * The activity to show in the status strip. The strip shows one agent only —
 * whichever started first — because several agents' actions competing for the
 * same line is noise. Other live agents still have their cards in the
 * assistant tab.
 */
export function leadActivity(chat: ChatSessionState): AgentActivity | null {
  const lead = listLiveAnswers(chat)[0];
  if (!lead) return null;
  return {
    runId: lead.runId,
    agentId: lead.agentId,
    ...activityOf(lead.message.blocks),
  };
}

export type LiveAnswerMessage = Extract<ChatMessage, { kind: 'assistant' }>;

export interface LiveAnswer {
  runId: string;
  agentId: string | null;
  /** The room task behind this run, when a frame has named it. */
  taskId?: string | null;
  message: LiveAnswerMessage;
}

/**
 * The unfinished assistant message a per-run stream is writing into.
 *
 * A room answer carries a `runId` on its message; the per-run reducer instead
 * keeps the number on `chat.runId` and grows the last message in place.
 */
function lastLiveMessage(chat: ChatSessionState): LiveAnswerMessage | null {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const item = chat.messages[index]!;
    if (item.kind !== 'assistant') continue;
    if (!item.done) return item;
  }
  return null;
}

/**
 * A run's still-running answer.
 *
 * Room turns keep live answers in `pendingAnswers`; a per-run stream (scheduled
 * tasks, command runs) writes them straight into `messages`. Both are live and
 * both can carry a blocking question, so callers must not assume the first.
 */
export function findLiveAnswer(chat: ChatSessionState, runId: string): LiveAnswer | null {
  const pending = chat.pendingAnswers.find((answer) => answer.runId === runId);
  if (pending) return pending;
  const direct = chat.messages.find(
    (item): item is LiveAnswerMessage =>
      item.kind === 'assistant' && item.runId === runId && !item.done,
  );
  if (direct) return { runId, agentId: direct.agentId ?? null, taskId: null, message: direct };
  if (chat.runId === runId) {
    const message = lastLiveMessage(chat);
    if (message) return { runId, agentId: message.agentId ?? null, taskId: null, message };
  }
  return null;
}

/** Every still-running answer, deduped by run id. */
export function listLiveAnswers(chat: ChatSessionState): LiveAnswer[] {
  const answers: LiveAnswer[] = [...chat.pendingAnswers];
  const seen = new Set(answers.map((answer) => answer.runId));
  for (const item of chat.messages) {
    if (item.kind !== 'assistant' || item.done || !item.runId || seen.has(item.runId)) continue;
    seen.add(item.runId);
    answers.push({ runId: item.runId, agentId: item.agentId ?? null, taskId: null, message: item });
  }
  if (chat.runId && !seen.has(chat.runId)) {
    const message = lastLiveMessage(chat);
    if (message) {
      answers.push({ runId: chat.runId, agentId: message.agentId ?? null, taskId: null, message });
    }
  }
  return answers;
}

/**
 * Where an already-open trace pane should point after the user jumps to the
 * assistant tab from the live strip.
 *
 * `openRunId` is whatever the user last opened, which may belong to an agent
 * that already finished — keeping it would show "the previous agent's trace"
 * while sending them to whatever is running now.
 *
 * A closed pane stays closed (the strip asks to show current work, not to open
 * a trace). An open pane is kept when its run is still live. When that run has
 * finished there is only an unambiguous answer if exactly one agent is running;
 * with several, following any one of them would hide the rest, so the pane is
 * closed and the tab's live cards — one per agent — become the chooser.
 */
export function traceTargetOnJump(
  chat: ChatSessionState,
  openRunId: string | null,
): string | null {
  if (openRunId === null) return null;
  const live = listLiveAnswers(chat);
  if (live.some((answer) => answer.runId === openRunId)) return openRunId;
  return live.length === 1 ? live[0]!.runId : null;
}

/** The first live answer blocked on an unanswered question. */
export function findAwaitingAnswer(chat: ChatSessionState): LiveAnswer | null {
  return (
    listLiveAnswers(chat).find((answer) => hasUnansweredQuestion(answer.message.blocks)) ?? null
  );
}
