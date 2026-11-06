import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';
import type { SkillRegistry } from './registry.js';

const DEFAULT_DESCRIPTION_MAX_CHARS = 500;

export interface SkillsCatalogOptions {
  /** Per-skill description/when-to-use cap in the progressive-disclosure catalog. */
  descriptionMaxChars?: number;
}

/** Progressive-disclosure catalog: names/descriptions only, never skill bodies. */
export class SkillsCatalogContextSource implements RuntimeContextSource {
  readonly id = 'skills-catalog';
  private readonly descriptionMaxChars: number;

  constructor(
    private readonly registry: SkillRegistry,
    options: SkillsCatalogOptions = {},
  ) {
    this.descriptionMaxChars = options.descriptionMaxChars ?? DEFAULT_DESCRIPTION_MAX_CHARS;
  }

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
      const description = capText(skill.description, this.descriptionMaxChars);
      const when = skill.whenToUse
        ? ` when: ${capText(skill.whenToUse, this.descriptionMaxChars)}`
        : '';
      lines.push(`- ${skill.id} — ${skill.name}: ${description}${when} [${skill.source}]`);
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

function capText(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}
