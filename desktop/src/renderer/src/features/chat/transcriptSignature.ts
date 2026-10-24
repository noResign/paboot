import type { ChatMessage } from '../../store/chat/types';

/**
 * A cheap stand-in for "the transcript rendered something new".
 *
 * The scroll follower needs to re-run on every streamed token, so it cannot
 * deep-compare the message list — but it does need to change for *any* visible
 * growth: a new message, more text, a tool result landing, a block appearing.
 * Counting characters of the last message covers all of those for the only
 * message that can still change.
 */
export function transcriptSignature(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  return `${messages.length}:${last ? messageWeight(last) : 0}`;
}

function messageWeight(message: ChatMessage): number {
  if (message.kind === 'user') return message.text.length;
  let weight = 0;
  for (const block of message.blocks) {
    switch (block.kind) {
      case 'text':
        weight += block.text.length;
        break;
      case 'thinking':
        weight += 1;
        break;
      case 'tool':
        weight += block.name.length + (block.result?.length ?? 0) + (block.running ? 0 : 1);
        break;
      case 'question':
        weight += block.questions.length;
        break;
    }
  }
  return weight;
}
