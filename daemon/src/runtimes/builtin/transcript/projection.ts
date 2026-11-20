import type { NativeMessage } from '../../../types/transcript.js';

/**
 * Runtime-context is durable history, but the model request only needs the
 * newest complete snapshot. Older snapshots remain in SQLite for audit and
 * replay.
 */
export function selectActiveRuntimeContext(messages: readonly NativeMessage[]): NativeMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.source.kind === 'runtime-context') return message;
  }
  return null;
}

/**
 * Runtime context now lives in the system prompt, so historical snapshots are
 * audited in SQLite but never rendered as chat messages (including sessions
 * written before the move).
 */
export function projectActiveMessages(messages: readonly NativeMessage[]): NativeMessage[] {
  return messages.filter((message) => message.source.kind !== 'runtime-context');
}
