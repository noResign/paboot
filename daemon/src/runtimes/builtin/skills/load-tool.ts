import type { ToolDescriptor } from '../types.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from '../tools/types.js';
import { ToolError } from '../tools/types.js';
import type { SkillRegistry } from './registry.js';

export interface LoadSkillToolOptions {
  /** Skill ids visible to this agent; undefined = all. */
  allowedSkills?: readonly string[];
}

export function createLoadSkillTool(
  registry: SkillRegistry,
  options: LoadSkillToolOptions = {},
): ToolImplementation {
  const descriptor: ToolDescriptor = {
    name: 'load_skill',
    title: 'Load Skill',
    description:
      'Load the full instructions for one available skill. Use this only when the skill description matches the task.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill id from the Available skills catalog.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'read',
    concurrencySafe: true,
    timeoutMs: 5_000,
  };

  return {
    descriptor,
    call(input: unknown, _context: ToolCallContext): ToolResult {
      if (!isRecord(input) || typeof input['name'] !== 'string' || !input['name'].trim()) {
        throw new ToolError('name must be a non-empty skill id', 'skill_invalid_input');
      }
      const id = input['name'].trim();
      if (
        options.allowedSkills !== undefined &&
        !options.allowedSkills.includes(id)
      ) {
        throw new ToolError(`skill is not available to this agent: ${id}`, 'skill_not_allowed');
      }
      const skill = registry.load(id);
      if (!skill) throw new ToolError(`skill not found: ${id}`, 'skill_not_found');

      const parts = [
        `# Skill: ${skill.name}`,
        `id: ${skill.id}`,
        `source: ${skill.source}`,
        `version: ${skill.version}`,
      ];
      if (skill.whenToUse) parts.push(`when to use: ${skill.whenToUse}`);
      if (skill.allowedTools && skill.allowedTools.length > 0) {
        parts.push(`allowed tools (advisory): ${skill.allowedTools.join(', ')}`);
      }
      parts.push('', skill.body);
      return {
        content: parts.join('\n').trim(),
        isError: false,
        meta: {
          skillId: skill.id,
          source: skill.source,
          version: skill.version,
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
