import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';

/** Daemon-owned facts about the current step. No secrets or environment dumps. */
export class EnvironmentContextSource implements RuntimeContextSource {
  readonly id = 'environment';

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    const now = context.now ?? Date.now();
    const date = new Date(now).toISOString();
    const lines = [
      '## Runtime environment',
      `- workspace: ${context.agent.workspace.name} (${context.agent.workspace.id})`,
      `- workspace root: ${context.agent.workspace.root}`,
      `- cwd: ${context.agent.cwd}`,
      `- platform: ${process.platform} ${process.arch}`,
      `- time (UTC): ${date}`,
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
