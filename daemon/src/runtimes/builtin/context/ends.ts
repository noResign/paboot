import { renderEndContext } from '../../../ends/render.js';
import type { SessionEndsScope } from '../../../ends/scope.js';
import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';

/**
 * Ends for the builtin runtime.
 *
 * External runtimes get this as a first-message prelude (`runs/end-context`);
 * builtin has no prelude channel, so before this source existed a builtin run
 * received no end context at all — it could not see which end was primary, nor
 * the author's description and notes for it. Both channels now render through
 * `renderEndContext`, so the content matches.
 *
 * The resolver is injected because it needs the session row (cwd, explicit
 * `end_id`), while this source is handed only a snapshot.
 */
export class EndsContextSource implements RuntimeContextSource {
  readonly id = 'ends';

  constructor(private readonly resolve: () => SessionEndsScope) {}

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    if (context.agent.workspace.family !== 'dev') return [];
    const { ends, primary } = this.resolve();
    if (ends.length === 0 || !primary) return [];

    const rendered = renderEndContext(ends, primary);
    const contributions: RuntimeContextContribution[] = [];
    if (rendered.primary) {
      contributions.push({
        source: 'end:primary',
        kind: 'end',
        stability: 'dynamic',
        trust: 'workspace',
        priority: 14,
        content: rendered.primary,
      });
    }
    contributions.push({
      source: 'end:index',
      kind: 'end',
      stability: 'dynamic',
      trust: 'workspace',
      priority: 13,
      content: rendered.index,
    });
    return contributions;
  }
}
