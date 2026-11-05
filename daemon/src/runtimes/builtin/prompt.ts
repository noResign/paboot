import { createHash } from 'node:crypto';

import type {
  AgentProfile,
  AgentRunContext,
  ModelSnapshot,
  SessionSnapshot,
  SkillManifest,
  ToolDescriptor,
  WorkspaceSnapshot,
} from './types.js';

export type PromptStability = 'stable' | 'dynamic';
export type PromptTrust = 'system' | 'agent' | 'workspace' | 'external';

/** One reusable system-prompt contribution. */
export interface PromptSectionSpec {
  /** Stable identity; mixins/agents override by id, never by rendered text. */
  id: string;
  order: number;
  stability: PromptStability;
  trust: PromptTrust;
  /** Declarative predicate evaluated before rendering. */
  when?: (context: PromptBuildContext) => boolean;
  /** Static template or a function of the typed build context. */
  template: string | ((context: PromptBuildContext) => string);
  /** Whole-section cap in characters. Over-cap sections are dropped. */
  maxChars?: number;
}

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface SkillPolicy {
  allow?: string[];
  deny?: string[];
}

/** Composable agent prompt recipe. P3 supports one base plus ordered mixins. */
export interface AgentPromptPreset {
  id: string;
  version: number;
  base?: string;
  mixins?: string[];
  sections?: PromptSectionSpec[];
  /** Context-source ids this agent may consume. */
  contextSources?: string[];
  toolPolicy?: ToolPolicy;
  skillPolicy?: SkillPolicy;
}

export interface PromptBuildContext {
  agent: AgentRunContext;
  profile: AgentProfile;
  preset: AgentPromptPreset;
  session: SessionSnapshot;
  workspace: WorkspaceSnapshot;
  model: ModelSnapshot;
  toolSet: readonly ToolDescriptor[];
  skillCatalog: readonly SkillManifest[];
  /** Normalized facts; callers must not put random or per-call data here. */
  stepFacts: Readonly<Record<string, string | number | boolean>>;
  signal: AbortSignal;
}

export interface CompiledPromptSection {
  id: string;
  order: number;
  stability: PromptStability;
  trust: PromptTrust;
  text: string;
}

export type PromptOmissionReason = 'empty' | 'condition' | 'section_budget' | 'duplicate';

export interface PromptOmission {
  id: string;
  reason: PromptOmissionReason;
}

export interface PromptCompileResult {
  stableText: string;
  dynamicText: string;
  /** stableText + blank line + dynamicText; empty parts are omitted. */
  text: string;
  sections: CompiledPromptSection[];
  omitted: PromptOmission[];
  /** Hash of the exact model-facing system text. */
  version: string;
}

export class PromptCompileError extends Error {
  constructor(
    readonly code: 'unresolved_variable' | 'preset_cycle' | 'unknown_preset' | 'trust_override',
    message: string,
  ) {
    super(message);
    this.name = 'PromptCompileError';
  }
}

const TRUST_RANK: Record<PromptTrust, number> = {
  external: 0,
  workspace: 1,
  agent: 2,
  system: 3,
};

/**
 * Merge ordered layers from broad to narrow. Same-id sections replace earlier
 * ones unless that would let a lower-trust layer override the system floor.
 */
export function mergePromptSections(layers: readonly (readonly PromptSectionSpec[])[]): PromptSectionSpec[] {
  const byId = new Map<string, PromptSectionSpec>();
  for (const layer of layers) {
    for (const section of layer) {
      const existing = byId.get(section.id);
      if (existing && TRUST_RANK[section.trust] < TRUST_RANK[existing.trust]) {
        throw new PromptCompileError(
          'trust_override',
          `section "${section.id}" (${section.trust}) cannot override ${existing.trust}`,
        );
      }
      byId.set(section.id, section);
    }
  }
  return [...byId.values()];
}

/** Resolve a base + ordered mixins + the preset itself, with cycle detection. */
export function resolvePromptPreset(
  presets: ReadonlyMap<string, AgentPromptPreset>,
  id: string,
): AgentPromptPreset {
  const stack: string[] = [];
  const resolved = new Map<string, AgentPromptPreset>();

  const visit = (currentId: string): AgentPromptPreset => {
    const cached = resolved.get(currentId);
    if (cached) return cached;
    if (stack.includes(currentId)) {
      throw new PromptCompileError('preset_cycle', `prompt preset cycle: ${[...stack, currentId].join(' -> ')}`);
    }
    const preset = presets.get(currentId);
    if (!preset) throw new PromptCompileError('unknown_preset', `unknown prompt preset "${currentId}"`);

    stack.push(currentId);
    const inherited: AgentPromptPreset[] = [];
    if (preset.base) inherited.push(visit(preset.base));
    for (const mixin of preset.mixins ?? []) inherited.push(visit(mixin));
    stack.pop();

    const sections = mergePromptSections([
      ...inherited.map((item) => item.sections ?? []),
      preset.sections ?? [],
    ]);
    const contextSources = [
      ...new Set([...inherited.flatMap((item) => item.contextSources ?? []), ...(preset.contextSources ?? [])]),
    ];
    const result: AgentPromptPreset = {
      ...preset,
      sections,
      contextSources,
      toolPolicy: mergeToolPolicy([...inherited.map((item) => item.toolPolicy), preset.toolPolicy]),
      skillPolicy: mergeSkillPolicy([...inherited.map((item) => item.skillPolicy), preset.skillPolicy]),
    };
    resolved.set(currentId, result);
    return result;
  };

  return visit(id);
}

function mergeToolPolicy(policies: readonly (ToolPolicy | undefined)[]): ToolPolicy | undefined {
  const defined = policies.filter((policy): policy is ToolPolicy => policy !== undefined);
  if (defined.length === 0) return undefined;
  const deny = [...new Set(defined.flatMap((policy) => policy.deny ?? []))];
  const allow = lastDefinedAllow(defined);
  return {
    ...(allow === undefined ? {} : { allow: [...allow] }),
    ...(deny.length === 0 ? {} : { deny }),
  };
}

function mergeSkillPolicy(policies: readonly (SkillPolicy | undefined)[]): SkillPolicy | undefined {
  const defined = policies.filter((policy): policy is SkillPolicy => policy !== undefined);
  if (defined.length === 0) return undefined;
  const deny = [...new Set(defined.flatMap((policy) => policy.deny ?? []))];
  const allow = lastDefinedAllow(defined);
  return {
    ...(allow === undefined ? {} : { allow: [...allow] }),
    ...(deny.length === 0 ? {} : { deny }),
  };
}

function lastDefinedAllow(policies: readonly (ToolPolicy | SkillPolicy)[]): string[] | undefined {
  for (let index = policies.length - 1; index >= 0; index -= 1) {
    const allow = policies[index]!.allow;
    if (allow !== undefined) return allow;
  }
  return undefined;
}

/**
 * Compile ordered sections into deterministic stable/dynamic text. Conditions,
 * variables and budgets are resolved here; ordering is order then id.
 */
export function compilePromptSections(
  sections: readonly PromptSectionSpec[],
  context: PromptBuildContext,
): PromptCompileResult {
  const variables = promptVariables(context);
  const sorted = [...sections].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const compiled: CompiledPromptSection[] = [];
  const omitted: PromptOmission[] = [];

  for (const section of sorted) {
    if (seen.has(section.id)) {
      omitted.push({ id: section.id, reason: 'duplicate' });
      continue;
    }
    seen.add(section.id);
    if (section.when && !section.when(context)) {
      omitted.push({ id: section.id, reason: 'condition' });
      continue;
    }
    const raw = typeof section.template === 'function' ? section.template(context) : section.template;
    const text = interpolate(raw, variables).trim();
    if (text.length === 0) {
      omitted.push({ id: section.id, reason: 'empty' });
      continue;
    }
    if (section.maxChars !== undefined && text.length > section.maxChars) {
      omitted.push({ id: section.id, reason: 'section_budget' });
      continue;
    }
    compiled.push({
      id: section.id,
      order: section.order,
      stability: section.stability,
      trust: section.trust,
      text,
    });
  }

  const stableText = compiled
    .filter((section) => section.stability === 'stable')
    .map((section) => section.text)
    .join('\n\n');
  const dynamicText = compiled
    .filter((section) => section.stability === 'dynamic')
    .map((section) => section.text)
    .join('\n\n');
  const text = [stableText, dynamicText].filter(Boolean).join('\n\n');
  return {
    stableText,
    dynamicText,
    text,
    sections: compiled,
    omitted,
    version: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
  };
}

/** Compile a resolved preset for one agent/step. */
export function compileAgentPrompt(
  presets: ReadonlyMap<string, AgentPromptPreset>,
  presetId: string,
  context: PromptBuildContext,
  globalSections: readonly PromptSectionSpec[] = [],
): PromptCompileResult {
  const preset = resolvePromptPreset(presets, presetId);
  return compilePromptSections(
    mergePromptSections([globalSections, preset.sections ?? []]),
    { ...context, preset },
  );
}

/** Build the deterministic, model-facing tool inventory used by prompt sections. */
export function renderToolGuidance(tools: readonly ToolDescriptor[]): string {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join('\n');
}

function promptVariables(context: PromptBuildContext): Record<string, string> {
  return {
    'agent.id': context.agent.actor.id,
    'agent.name': context.agent.actor.name,
    'agent.role': context.agent.actor.role ?? '',
    'model.provider': context.model.provider,
    'model.model': context.model.model,
    'workspace.id': context.workspace.id,
    'workspace.name': context.workspace.name,
    'session.id': context.session.id,
    cwd: context.agent.cwd,
    ...Object.fromEntries(Object.entries(context.stepFacts).map(([key, value]) => [key, String(value)])),
  };
}

function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new PromptCompileError(
        'unresolved_variable',
        `prompt variable "${name}" is not registered for this assembly`,
      );
    }
    return value;
  });
}

