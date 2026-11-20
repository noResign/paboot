import type { AppContext } from '../app/context.js';
import type { SessionRow, WorkspaceRow } from '../db/db.js';
import { renderContextPrelude, type ContextPrelude } from '../context/prelude.js';
import { buildConfirmedProfile } from '../memory/brief.js';
import { resolveReadPolicy } from '../memory/read-policy.js';
import { isMemoryInjectionEnabled } from '../memory/settings.js';
import { log } from '../platform/log.js';

export interface RunMemoryContext extends ContextPrelude {
  /** [debug] Kept for compatibility; the index injects no claims. */
  claims: number;
  truncated: boolean;
  /** [debug] Kept for compatibility; the index injects no claims. */
  usedClaimIds: string[];
}

/** Progressive disclosure: a fixed instruction, never the claim list itself. */
const MEMORY_INDEX = [
  '## 长期记忆',
  '本机保存了跨会话的长期记忆。涉及用户偏好、过去决定、未完成事项，或用户说「上次 / 之前 / 记得」时，',
  '先调用 `search_memory(query)` 查询；需要原文用 `memory_source(id)`，需要时间线用 `memory_timeline`，',
  '未完成事项用 `list_open_loops`。不要凭印象编造记忆内容。',
].join('\n');

/**
 * Static memory guidance for external runtimes. The claim list is no longer
 * injected: it changed every turn and invalidated the cached system prompt.
 * Details come from the memory tools, whose results append to the transcript.
 */
export function memoryContext(
  ctx: AppContext,
  session: SessionRow,
  workspace: WorkspaceRow,
): RunMemoryContext | null {
  if (!ctx.memory) return null;
  if (session.runtime === 'command' || session.runtime === 'builtin') return null;
  if (session.purpose === 'task_config') return null;
  if (session.memory_mode !== 'normal') return null;

  try {
    const settings = ctx.db.getMemorySettings(workspace.id);
    if (!isMemoryInjectionEnabled(workspace, settings)) return null;
    const policy = resolveReadPolicy({
      workspace,
      workspaces: ctx.db.listWorkspaces(),
      getSettings: (workspaceId) => ctx.db.getMemorySettings(workspaceId),
    });
    if (policy.scopes.length === 0) return null;
    const confirmed = buildConfirmedProfile(ctx.memory, policy);
    const content =
      confirmed.length > 0
        ? `${MEMORY_INDEX}\n\n## 已确认画像\n${confirmed.join('\n')}`
        : MEMORY_INDEX;
    const prelude = renderContextPrelude(
      [
        {
          kind: 'memory',
          scope: 'workspace',
          priority: 0,
          content,
          source: 'memory:index',
        },
      ],
      session.runtime,
    );
    if (!prelude) return null;
    log.info(`memory index: ${prelude.used} chars (progressive disclosure)`);
    return {
      ...prelude,
      claims: 0,
      truncated: false,
      usedClaimIds: [],
    };
  } catch (err) {
    // Injection is best-effort; a broken memory.db must not block the run.
    log.warn(`memory context failed for workspace ${workspace.id}: ${String(err)}`);
    return null;
  }
}
