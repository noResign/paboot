import {
  buildLifeBrief,
  buildMemoryBrief,
  DEFAULT_MEMORY_BRIEF_CHARS,
} from '../../../memory/brief.js';
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

export interface MemoryBriefContextSourceOptions {
  maxChars?: number;
  /**
   * Effective read policy for the run's workspace. Returning an empty scope
   * list disables injection (workspace off / injection off). When omitted the
   * source falls back to the M0 life-only behavior.
   */
  resolvePolicy?: (workspace: MemoryPolicyWorkspace) => MemoryReadPolicy;
}

/** Memory brief as a builtin runtime-context section. */
export class MemoryBriefContextSource implements RuntimeContextSource {
  readonly id = 'memory-brief';
  private readonly maxChars: number;
  private readonly resolvePolicy:
    | ((workspace: MemoryPolicyWorkspace) => MemoryReadPolicy)
    | undefined;

  constructor(
    private readonly store: MemoryStore,
    options: MemoryBriefContextSourceOptions = {},
  ) {
    this.maxChars = options.maxChars ?? DEFAULT_MEMORY_BRIEF_CHARS;
    this.resolvePolicy = options.resolvePolicy;
  }

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    const workspace = context.agent.workspace;
    // Builtin gets memory through this source instead of runs/memory-context,
    // so it must enforce the same session switch here. Missing mode is treated
    // as no-injection (older callers/tests cannot accidentally leak memory).
    if (context.session.memoryMode !== 'normal') return [];
    if (context.session.purpose === 'task_config') return [];
    if (!this.resolvePolicy && workspace.family !== 'life') return [];

    const policy = this.resolvePolicy?.(workspace);
    if (policy && policy.scopes.length === 0) return [];
    // D39: same rule as runs/memory-context — never echo this session's own
    // claims back into the transcript they were extracted from.
    const brief = policy
      ? buildMemoryBrief(this.store, policy, {
          maxChars: this.maxChars,
          now: context.now,
          scope: `workspace:${workspace.id}`,
          includePrivate: workspace.family === 'life',
          excludeSessionId: context.session.id,
        })
      : buildLifeBrief(this.store, `workspace:${workspace.id}`, {
          maxChars: this.maxChars,
          now: context.now,
          excludeSessionId: context.session.id,
        });
    if (!brief) return [];
    const contributions: RuntimeContextContribution[] = [
      {
        source: 'memory:brief',
        kind: 'memory',
        stability: 'dynamic',
        trust: 'workspace',
        // After environment / project docs / knowledge.
        priority: 8,
        content: brief.markdown,
      },
    ];
    return contributions;
  }
}
