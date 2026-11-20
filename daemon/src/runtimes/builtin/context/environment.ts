import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';

/** Daemon-owned facts about the current step. No secrets or environment dumps. */
export class EnvironmentContextSource implements RuntimeContextSource {
  readonly id = 'environment';

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    // No clock here: a per-run timestamp would rewrite the cached system prompt
    // every turn for information the model can get from a tool or the user.
    const lines = [
      '## Runtime environment',
      `- workspace: ${context.agent.workspace.name} (${context.agent.workspace.id})`,
      `- workspace root: ${context.agent.workspace.root}`,
      `- cwd: ${context.agent.cwd}`,
      `- platform: ${process.platform} ${process.arch}`,
    ];
    if (context.agent.extraDirs.length > 0) {
      lines.push(`- additional roots: ${context.agent.extraDirs.join(', ')}`);
    }
    return [
      {
        source: this.id,
        kind: 'environment',
        stability: 'dynamic',
        trust: 'system',
        priority: 100,
        content: lines.join('\n'),
        required: true,
      },
    ];
  }
}
