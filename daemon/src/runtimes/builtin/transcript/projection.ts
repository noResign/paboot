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

/** Keep all ordinary messages and only the newest runtime-context snapshot. */
export function projectActiveMessages(messages: readonly NativeMessage[]): NativeMessage[] {
  const active = selectActiveRuntimeContext(messages);
  return messages.filter(
    (message) => message.source.kind !== 'runtime-context' || message === active,
  );
}
