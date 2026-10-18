import { VERSION } from '../../version.js';
import type { ModelOption, ModelParameter } from '../types.js';
import {
  initializeCodexAppServer,
  spawnCodexAppServer,
  type CodexAppServerConnection,
} from './rpc.js';

const PAGE_TIMEOUT_MS = 10_000;

interface CodexModelRow {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

/** Codex reports supported efforts per model; surface them as a generic parameter. */
function reasoningParameter(row: CodexModelRow): ModelParameter | undefined {
  if (!Array.isArray(row.supportedReasoningEfforts)) return undefined;
  const ids = row.supportedReasoningEfforts
    .map((entry) =>
      entry && typeof entry === 'object'
        ? (entry as { reasoningEffort?: unknown }).reasoningEffort
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const unique = [...new Set(ids)];
  if (!unique.length) return undefined;
  const defaultId =
    typeof row.defaultReasoningEffort === 'string' && row.defaultReasoningEffort
      ? row.defaultReasoningEffort
      : undefined;
  return {
    id: 'reasoningEffort',
    label: 'Reasoning effort',
    values: unique.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id })),
    ...(defaultId ? { defaultId } : {}),
  };
}

interface CodexModelListResult {
  data?: unknown;
  nextCursor?: unknown;
}

/**
 * `model/list` is paginated. This is also where the model *slug* comes from:
 * newer app-server builds put it in `model`, older ones only in `id`.
 */
function toModelOption(row: CodexModelRow): ModelOption | null {
  const id =
    typeof row.model === 'string' && row.model
      ? row.model
      : typeof row.id === 'string'
        ? row.id
        : '';
  if (!id || row.hidden === true) return null;
  const label = typeof row.displayName === 'string' && row.displayName ? row.displayName : id;
  const parameter = reasoningParameter(row);
  return { id, label, ...(parameter ? { parameters: [parameter] } : {}) };
}

/**
 * Ask the local `codex app-server` for its catalogue. Takes a short-lived
 * process: the caller (Registry) caches the result, because a full spawn +
 * initialize costs far more than the models are worth on every picker open.
 */
export async function listCodexModels(bin: string, env: NodeJS.ProcessEnv): Promise<ModelOption[]> {
  let conn: CodexAppServerConnection | undefined;
  try {
    conn = spawnCodexAppServer({ command: bin, env });
    await initializeCodexAppServer(conn, { name: 'paboot', version: VERSION });

    const models: ModelOption[] = [];
    const seen = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const result = (await conn.request(
        'model/list',
        cursor ? { cursor } : {},
        PAGE_TIMEOUT_MS,
      )) as CodexModelListResult;
      const rows = Array.isArray(result?.data) ? (result.data as CodexModelRow[]) : [];

      for (const row of rows) {
        const option = toModelOption(row);
        if (option && !seen.has(option.id)) {
          seen.add(option.id);
          models.push(option);
        }
      }

      const next = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      // A server that echoes the same cursor would otherwise loop forever.
      cursor = next && !seenCursors.has(next) ? next : undefined;
      if (next) seenCursors.add(next);
    } while (cursor);

    return models;
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {
        // The child already exited; nothing left to shut down.
      }
    }
  }
}
