import type { RunCheckpointRow, RunRow } from './db.js';
import { parseStoredModelParameters } from './model-selection.js';
import type { RunDto } from './types/api.js';

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
