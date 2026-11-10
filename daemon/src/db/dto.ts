import type { RunCheckpointRow, RunRow } from './db.js';
import { parseStoredModelParameters } from './model-selection.js';
import type { RunDto } from '../types/api.js';

function parseAttachmentIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Shared run mapping so session and scheduled-task responses agree. */
export function runDto(
  r: RunRow,
  checkpoint?: RunCheckpointRow,
  workspaceId: string | null = null,
  output: string | null = null,
): RunDto {
  return {
    id: r.id,
    sessionId: r.session_id,
    workspaceId,
    runtime: r.runtime,
    model: r.model,
    modelParameters: parseStoredModelParameters(r.model_parameters),
    status: r.status,
    prompt: r.prompt,
    attachmentIds: parseAttachmentIds(r.attachment_ids),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    exitCode: r.exit_code,
    error: r.error,
    taskId: r.task_id ?? null,
    trigger: (r.trigger as RunDto['trigger']) ?? 'user',
    permissionMode: r.permission_mode,
    output,
    checkpoint: checkpoint
      ? {
          status: checkpoint.status,
          repoRoot: checkpoint.repo_root,
          preRef: checkpoint.pre_ref,
          postRef: checkpoint.post_ref,
        }
      : null,
  };
}
