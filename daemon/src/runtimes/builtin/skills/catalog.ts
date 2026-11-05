import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';
import type { SkillRegistry } from './registry.js';

/** Progressive-disclosure catalog: names/descriptions only, never skill bodies. */
export class SkillsCatalogContextSource implements RuntimeContextSource {
  readonly id = 'skills-catalog';

  constructor(private readonly registry: SkillRegistry) {}

  collect(context: RuntimeContextCollectContext): RuntimeContextContribution[] {
    const allowed = context.profile.allowedSkills;
    const skills = this.registry
      .list()
      .filter((skill) => allowed === undefined || allowed.includes(skill.id));
    if (skills.length === 0) return [];

    const lines = [
      '## Available skills',
      'Load a skill with the `load_skill` tool when its description matches the task. Skill bodies are not loaded by default.',
    ];
    for (const skill of skills) {
      const when = skill.whenToUse ? ` when: ${skill.whenToUse}` : '';
      lines.push(`- ${skill.id} — ${skill.name}: ${skill.description}${when} [${skill.source}]`);
    }
    return [
      {
        source: this.id,
        kind: 'skill-catalog',
        stability: 'dynamic',
        trust: 'workspace',
        priority: 20,
        content: lines.join('\n'),
      },
    ];
  }
}
