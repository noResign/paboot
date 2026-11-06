import { createHash } from 'node:crypto';

import type { PromptSectionSpec } from '../prompt.js';
import {
  compilePromptSections,
  mergePromptSections,
  renderToolGuidance,
  resolvePromptPreset,
  type AgentPromptPreset,
  type PromptBuildContext,
  type PromptCompileResult,
} from '../prompt.js';
import {
  collectRuntimeContext,
  type AgentContextProfile,
  type RuntimeContextCollectContext,
  type RuntimeContextSnapshot,
} from '../runtime-context.js';

export interface AgentContextAssembly {
  agentId: string;
  presetId: string;
  presetVersion: number;
  /** system channel: rebuilt every step for this agent. */
  system: PromptCompileResult;
  /** runtime-context channel: durable snapshot content. */
  runtimeContext: RuntimeContextSnapshot;
  /** Hash of both channels for diagnostics/cache comparison. */
  contextVersion: string;
}

export interface AssembleAgentContextInput {
  profile: AgentContextProfile;
  presets: ReadonlyMap<string, AgentPromptPreset>;
  globalSections: readonly PromptSectionSpec[];
  promptContext: PromptBuildContext;
  runtimeContextContext: RuntimeContextCollectContext;
  systemTokenBudget?: number;
  runtimeContextTokenBudget?: number;
  measure?: (text: string) => number;
}

/**
 * Compile one agent's system prompt and collect its runtime-context snapshot.
 * The two channels stay separate: system is not stored as chat history, while
 * runtime-context is persisted by the transcript layer.
 */
export async function assembleAgentContext(
  input: AssembleAgentContextInput,
): Promise<AgentContextAssembly> {
  const preset = input.presets.has(input.profile.promptPreset.id)
    ? resolvePromptPreset(input.presets, input.profile.promptPreset.id)
    : input.profile.promptPreset;
  const toolGuidance: PromptSectionSpec[] =
    input.promptContext.toolSet.length > 0
      ? [
          {
            id: 'generated.tool-guidance',
            order: 900,
            stability: 'stable',
            trust: 'system',
            template: `## Available tools\n${renderToolGuidance(input.promptContext.toolSet)}`,
          },
        ]
      : [];
  const systemSections = mergePromptSections([
    input.globalSections,
    preset.sections ?? [],
    input.profile.systemSections ?? [],
    toolGuidance,
  ]);
  const system = compilePromptSections(
    systemSections,
    { ...input.promptContext, preset },
    { maxTokens: input.systemTokenBudget, measure: input.measure },
  );
  const runtimeContext = await collectRuntimeContext(
    input.profile.contextSources,
    input.runtimeContextContext,
    { maxTokens: input.runtimeContextTokenBudget, measure: input.measure },
  );
  return {
    agentId: input.profile.agentId,
    presetId: preset.id,
    presetVersion: preset.version,
    system,
    runtimeContext,
    contextVersion: createHash('sha256')
      .update(`${system.version}:${runtimeContext.version}`, 'utf8')
      .digest('hex')
      .slice(0, 16),
  };
}
