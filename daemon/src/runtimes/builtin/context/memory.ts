import { buildLifeBrief, DEFAULT_MEMORY_BRIEF_CHARS } from '../../../memory/brief.js';
import type { MemoryStore } from '../../../memory/store.js';
import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';

/** Memory brief as a builtin runtime-context section (M0: life only). */
export class MemoryBriefContextSource implements RuntimeContextSource {
  readonly id = 'memory-brief';

  constructor(
    private readonly store: MemoryStore,
    private readonly maxChars: number = DEFAULT_MEMORY_BRIEF_CHARS,
  ) {}

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    const workspace = context.agent.workspace;
    if (workspace.family !== 'life') return [];
    // Builtin gets memory through this source instead of runs/memory-context,
    // so it must enforce the same session switch here. Missing mode is treated
    // as no-injection (older callers/tests cannot accidentally leak memory).
    if (context.session.memoryMode !== 'normal') return [];
    if (context.session.purpose === 'task_config') return [];
    const brief = buildLifeBrief(this.store, `workspace:${workspace.id}`, {
      maxChars: this.maxChars,
      now: context.now,
    });
    if (!brief) return [];
    return [
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
  }
}
