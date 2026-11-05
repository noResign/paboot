import { createHash } from 'node:crypto';

import type {
  AgentProfile,
  AgentRunContext,
  ModelSnapshot,
  SessionSnapshot,
  SkillManifest,
  ToolDescriptor,
} from './types.js';
import type { AgentPromptPreset, PromptSectionSpec, SkillPolicy, ToolPolicy } from './prompt.js';

export type RuntimeContextKind =
  | 'environment'
  | 'project'
  | 'knowledge'
  | 'memory'
  | 'skill-catalog'
  | 'todo'
  | 'other';

export type RuntimeContextTrust = 'system' | 'workspace' | 'external';

export interface RuntimeContextContribution {
  source: string;
  kind: RuntimeContextKind;
  stability: 'stable' | 'dynamic';
  trust: RuntimeContextTrust;
  priority: number;
  content: string;
  required?: boolean;
  /** Whole-contribution cap in characters. */
  tokenBudget?: number;
}

export interface RuntimeContextCollectContext {
  agent: AgentRunContext;
  profile: AgentProfile;
  session: SessionSnapshot;
  model: ModelSnapshot;
  toolSet: readonly ToolDescriptor[];
  skillCatalog: readonly SkillManifest[];
  signal: AbortSignal;
}

export interface RuntimeContextSource {
  id: string;
  collect(
    context: RuntimeContextCollectContext,
  ): Promise<RuntimeContextContribution[]> | RuntimeContextContribution[];
}

export interface RuntimeContextSnapshot {
  /** Exact model-facing text including the supersedes preamble. */
  text: string;
  contributions: RuntimeContextContribution[];
  version: string;
}

/** Effective context configuration for one agent. */
export interface AgentContextProfile {
  agentId: string;
  promptPreset: AgentPromptPreset;
  /** Extra system sections supplied by the agent beyond its preset. */
  systemSections?: readonly PromptSectionSpec[];
  contextSources: readonly RuntimeContextSource[];
  toolPolicy?: ToolPolicy;
  skillPolicy?: SkillPolicy;
}

/**
 * Collect contributions, dedupe by source (highest priority wins), sort by
 * priority then source, and render one complete superseding snapshot.
 */
export async function collectRuntimeContext(
  sources: readonly RuntimeContextSource[],
  context: RuntimeContextCollectContext,
): Promise<RuntimeContextSnapshot> {
  const collected: RuntimeContextContribution[] = [];
  for (const source of sources) {
    collected.push(...(await source.collect(context)));
  }
  collected.sort((a, b) => b.priority - a.priority || a.source.localeCompare(b.source));
  const bySource = new Map<string, RuntimeContextContribution>();
  for (const contribution of collected) {
    if (!bySource.has(contribution.source)) bySource.set(contribution.source, contribution);
  }
  const contributions = [...bySource.values()].filter((item) => item.content.trim().length > 0);
  const body = contributions
    .map((item) => item.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const text = body
    ? `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
    : '';
  return {
    text,
    contributions,
    version: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
  };
}
