import { buildConfirmedProfile } from '../../../memory/brief.js';
import type { MemoryReadPolicy } from '../../../memory/read-policy.js';
import type { MemoryStore } from '../../../memory/store.js';
import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';

/** The slice of a workspace the policy needs; builtin context carries a snapshot. */
export interface MemoryPolicyWorkspace {
  id: string;
  family: string;
}

export interface MemoryIndexContextSourceOptions {
  /**
   * Effective read policy for the run's workspace. Returning an empty scope
   * list disables the index (workspace off / injection off). When omitted the
   * source falls back to the M0 life-only behavior.
   */
  resolvePolicy?: (workspace: MemoryPolicyWorkspace) => MemoryReadPolicy;
  /** Store used only to render the few user-confirmed profile lines. */
  store?: MemoryStore;
}

const MEMORY_INDEX = [
  '## 长期记忆',
  '本机保存了跨会话的长期记忆。涉及用户偏好、过去决定、未完成事项，或用户说「上次 / 之前 / 记得」时，',
  '先调用 `search_memory(query)` 查询；需要原文用 `memory_source(id)`，需要时间线用 `memory_timeline`，',
  '未完成事项用 `list_open_loops`。不要凭印象编造记忆内容。',
].join('\n');

/**
 * Progressive disclosure for builtin memory: only a fixed instruction goes in
 * the system prompt; claims are fetched through the memory tools. Injecting the
 * full brief every step kept changing the cached prompt and put user-role
 * snapshots in the transcript.
 */
export class MemoryIndexContextSource implements RuntimeContextSource {
  readonly id = 'memory-index';
  private readonly resolvePolicy:
    | ((workspace: MemoryPolicyWorkspace) => MemoryReadPolicy)
    | undefined;
  private readonly store: MemoryStore | undefined;

  constructor(options: MemoryIndexContextSourceOptions = {}) {
    this.resolvePolicy = options.resolvePolicy;
    this.store = options.store;
  }

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    const workspace = context.agent.workspace;
    if (context.session.memoryMode !== 'normal') return [];
    if (context.session.purpose === 'task_config') return [];
    if (!this.resolvePolicy && workspace.family !== 'life') return [];

    const policy = this.resolvePolicy?.(workspace);
    if (policy && policy.scopes.length === 0) return [];
    const confirmed =
      policy && this.store
        ? buildConfirmedProfile(this.store, policy, { now: context.now })
        : [];
    const content =
      confirmed.length > 0
        ? `${MEMORY_INDEX}\n\n## 已确认画像\n${confirmed.join('\n')}`
        : MEMORY_INDEX;
    return [
      {
        source: 'memory:index',
        kind: 'memory',
        stability: 'stable',
        trust: 'workspace',
        priority: 8,
        content,
      },
    ];
  }
}
