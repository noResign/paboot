import { segmentBlocks } from './segments';
import type { ContentBlock } from '../../store/chat/types';

/**
 * The conversation transcript shows only user-facing content. Thinking and tool
 * calls stay available through the assistant tab's trace view.
 */
export function conversationSegments(blocks: ContentBlock[]) {
  return segmentBlocks(blocks).filter(
    (segment) =>
      segment.kind === 'text' || segment.kind === 'question' || segment.kind === 'notice',
  );
}

/** Whether the answer has thinking/tool detail hidden from the conversation. */
export function hasTraceSegments(blocks: ContentBlock[]): boolean {
  return segmentBlocks(blocks).some(
    (segment) => segment.kind === 'thinking' || segment.kind === 'tools',
  );
}

/**
 * An unanswered question blocks the run on the user. Builtin/Codex emit no
 * permission_request for these, so the live card is the only place that can
 * tell the user to open it.
 */
export function hasUnansweredQuestion(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === 'question' && !block.answered && !block.answerStatus,
  );
}

/**
 * Whether a question card from the committed transcript still belongs to the
 * current turn.
 *
 * `answered` is client-only state that every history rebuild resets, so it
 * cannot distinguish a live question from a months-old one. The durable signal
 * is position: a question is answerable only while it answers the latest user
 * message.
 *
 * Room runs carry a turnId, which is exact even when a slow answer commits after
 * a newer question. Legacy single-agent runs have no turnId, so we fall back to
 * "after the latest user message".
 */
export function questionInteractive(input: {
  /** Absolute index in the full `messages` array. */
  index: number;
  /** Index of the latest user message, or -1 when there is none. */
  lastUserIndex: number;
  runTurnId: string | null;
  lastUserTurnId: string | null;
}): boolean {
  if (input.lastUserIndex < 0) return false;
  if (input.runTurnId !== null && input.lastUserTurnId !== null) {
    return input.runTurnId === input.lastUserTurnId;
  }
  return input.index > input.lastUserIndex;
}
