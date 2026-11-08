import type { EndRow, MessageRow, SessionRow, WorkspaceRow } from '../db/db.js';
import { filterCaptureText } from './capture-filter.js';
import { resolveRunMemoryScope } from './scope-resolver.js';
import { hashContent, type MemoryStore } from './store.js';

export interface CaptureRunInput {
  store: MemoryStore;
  session: SessionRow;
  workspace: WorkspaceRow;
  ends: readonly EndRow[];
  messages: readonly MessageRow[];
  runId: string;
}

/**
 * Capture one run's visible messages into L0. Safe to call after every run:
 * sources are deduped by `(scope, end, session, source_table, message_id)`, so
 * re-scanning older messages is a no-op. Private/no-memory spans and injected
 * context are stripped before insert; tombstones suppress re-capture.
 *
 * Returns the number of newly created sources.
 */
export function captureRunMessages(input: CaptureRunInput): number {
  const scope = resolveRunMemoryScope(input.session, input.workspace, input.ends, input.runId);
  if (!scope) return 0;

  const seen = input.store.capturedMessageIds(scope.scope, scope.sessionId);
  const afterMessageId = Number(input.session.memory_capture_after_message_id ?? 0);
  let captured = 0;

  for (const message of input.messages) {
    if (message.id <= afterMessageId) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (seen.has(message.id)) continue;

    const content = filterCaptureText(message.content);
    if (content === '') continue;

    const contentHash = hashContent(content);
    if (input.store.hasTombstone(scope.scope, scope.endId, contentHash)) continue;

    const result = input.store.insertSource({
      scope: scope.scope,
      workspaceId: scope.workspaceId,
      endId: scope.endId,
      kind: 'message',
      sourceTable: 'messages',
      sessionId: scope.sessionId,
      runId: scope.runId,
      messageId: message.id,
      occurredAt: message.created_at,
      content,
      meta: { role: message.role },
    });
    if (result.created) captured += 1;
  }

  return captured;
}
