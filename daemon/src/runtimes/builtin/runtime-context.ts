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
  /** Normalized current time for deterministic source rendering/tests. */
  now?: number;
}

export interface RuntimeContextSource {
  id: string;
  collect(
    context: RuntimeContextCollectContext,
  ): Promise<RuntimeContextContribution[]> | RuntimeContextContribution[];
}

export type RuntimeContextOmissionReason =
  | 'empty'
  | 'duplicate'
  | 'section_budget'
  | 'budget'
  | 'source_error';

export interface RuntimeContextOmission {
  source: string;
  reason: RuntimeContextOmissionReason;
}

export interface RuntimeContextSnapshot {
  /** Exact model-facing text including the supersedes preamble. */
  text: string;
  contributions: RuntimeContextContribution[];
  omitted: RuntimeContextOmission[];
  /** True when a contribution was dropped because it did not fit a budget. */
  overBudget: boolean;
  version: string;
}

export interface RuntimeContextCollectionOptions {
  /** Total cap for the rendered runtime-context body, in measure units. */
  maxChars?: number;
  measure?: (text: string) => number;
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
  options: RuntimeContextCollectionOptions = {},
): Promise<RuntimeContextSnapshot> {
  const collected: RuntimeContextContribution[] = [];
  const omitted: RuntimeContextOmission[] = [];
  for (const source of sources) {
    try {
      collected.push(...(await source.collect(context)));
    } catch {
      omitted.push({ source: source.id, reason: 'source_error' });
    }
  }

  collected.sort((a, b) => b.priority - a.priority || a.source.localeCompare(b.source));
  const bySource = new Map<string, RuntimeContextContribution>();
  for (const contribution of collected) {
    if (bySource.has(contribution.source)) {
      omitted.push({ source: contribution.source, reason: 'duplicate' });
      continue;
    }
    bySource.set(contribution.source, contribution);
  }

  const measure = options.measure ?? ((text: string) => text.length);
  let overBudget = false;
  const measured: RuntimeContextContribution[] = [];
  for (const contribution of bySource.values()) {
    if (contribution.content.trim().length === 0) {
      omitted.push({ source: contribution.source, reason: 'empty' });
      continue;
    }
    if (
      contribution.tokenBudget !== undefined &&
      measure(contribution.content.trim()) > contribution.tokenBudget
    ) {
      omitted.push({ source: contribution.source, reason: 'section_budget' });
      overBudget = true;
      continue;
    }
    measured.push(contribution);
  }

  const included = [...measured];
  if (options.maxChars !== undefined) {
    while (measure(renderBody(included)) > options.maxChars) {
      let dropIndex = -1;
      for (let index = included.length - 1; index >= 0; index -= 1) {
        if (!included[index]!.required) {
          dropIndex = index;
          break;
        }
      }
      if (dropIndex < 0) {
        // Required operational context wins over the soft budget; keep it and
        // make the overflow visible to the caller.
        overBudget = true;
        break;
      }
      const [dropped] = included.splice(dropIndex, 1);
      omitted.push({ source: dropped!.source, reason: 'budget' });
      overBudget = true;
    }
  }

  const body = renderBody(included);
  const text = body
    ? `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
    : '';
  omitted.sort((a, b) => a.source.localeCompare(b.source) || a.reason.localeCompare(b.reason));
  return {
    text,
    contributions: included,
    omitted,
    overBudget,
    version: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
  };
}

function renderBody(contributions: readonly RuntimeContextContribution[]): string {
  return contributions
    .map((item) => item.content.trim())
    .filter(Boolean)
    .join('\n\n');
}
