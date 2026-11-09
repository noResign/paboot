import type { EndRow, MemorySettingsRow, SessionRow, WorkspaceRow } from '../db/db.js';
import { isMemoryEnabled } from './settings.js';
import type { MemoryScope } from './types.js';

export interface MemoryRunScope {
  scope: MemoryScope;
  workspaceId: string;
  endId: string | null;
  sessionId: string;
  runId: string | null;
}

/**
 * M0 captures life chats only. Command-task internals and the AI authoring chat
 * are excluded (D30); `off` disables capture for the session, while
 * `no_injection` still records (it only suppresses briefs).
 */
export function shouldCaptureSession(session: SessionRow): boolean {
  if (session.kind !== 'chat') return false;
  if (session.runtime === 'command') return false;
  if (session.purpose === 'task_config') return false;
  return session.memory_mode !== 'off';
}

/**
 * Freeze the write scope for one run. The model never supplies scope; the
 * server derives it from the session + workspace. Dev workspaces are opt-in
 * (`memory_settings.enabled`); life is on unless explicitly disabled.
 */
export function resolveRunMemoryScope(
  session: SessionRow,
  workspace: WorkspaceRow,
  ends: readonly EndRow[],
  runId: string | null = null,
  settings?: MemorySettingsRow,
): MemoryRunScope | null {
  if (!shouldCaptureSession(session)) return null;
  if (!isMemoryEnabled(workspace, settings)) return null;

  const lifeEnd =
    workspace.family === 'life'
      ? ends.find((end) => end.kind === 'life' && end.status === 'active')
      : undefined;
  return {
    scope: `workspace:${workspace.id}`,
    workspaceId: workspace.id,
    endId: session.end_id ?? lifeEnd?.id ?? null,
    sessionId: session.id,
    runId,
  };
}
