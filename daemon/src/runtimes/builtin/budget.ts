import type { BuiltinRuntimeConfig } from './config.js';
import type { AgentBudget, AgentBudgetUsage, BudgetExhaustedReason } from './types.js';

/** Token budgets for one run, derived from the model window and builtin config. */
export interface BuiltinContextBudget {
  /** Effective window used for the ratios (real catalogue value or fallback). */
  contextWindowTokens: number;
  systemPromptTokens: number;
  runtimeContextTokens: number;
  /** Project docs may use at most this share of runtimeContextTokens. */
  projectDocsTokens: number;
  /** Per-tool-result cap, applied before events/transcript storage. */
  maxResultTokens: number;
  maxSteps: number;
  maxToolCalls: number;
}

const MIN_SYSTEM_TOKENS = 256;
const MIN_RUNTIME_TOKENS = 512;
const MIN_PROJECT_DOC_TOKENS = 256;

/** Resolve window-relative budgets for one model. */
export function resolveContextBudget(
  config: BuiltinRuntimeConfig,
  contextWindow: number | undefined,
): BuiltinContextBudget {
  const window =
    contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : config.context.fallbackWindowTokens;
  const systemPromptTokens = Math.max(
    MIN_SYSTEM_TOKENS,
    Math.min(
      Math.ceil(window * config.context.systemPromptRatio),
      config.context.maxSystemPromptTokens,
    ),
  );
  const runtimeContextTokens = Math.max(
    MIN_RUNTIME_TOKENS,
    Math.min(
      Math.ceil(window * config.context.runtimeContextRatio),
      config.context.maxRuntimeContextTokens,
    ),
  );
  const projectDocsTokens = Math.max(
    MIN_PROJECT_DOC_TOKENS,
    Math.min(
      Math.ceil(runtimeContextTokens * config.projectDocs.shareOfRuntimeContext),
      config.projectDocs.maxTokens,
    ),
  );
  return {
    contextWindowTokens: window,
    systemPromptTokens,
    runtimeContextTokens,
    projectDocsTokens,
    maxResultTokens: config.tools.maxResultTokens,
    maxSteps: config.agent.maxSteps,
    maxToolCalls: config.agent.maxToolCalls,
  };
}

/** Return the first exhausted budget dimension, or `null` when still allowed. */
export function budgetExhaustedReason(
  budget: AgentBudget,
  usage: AgentBudgetUsage,
  now: number = Date.now(),
): BudgetExhaustedReason | null {
  if (usage.steps >= budget.maxSteps) return 'steps';
  if (usage.toolCalls >= budget.maxToolCalls) return 'tool_calls';
  if (budget.maxInputTokens !== undefined && usage.inputTokens >= budget.maxInputTokens) {
    return 'input_tokens';
  }
  if (budget.maxOutputTokens !== undefined && usage.outputTokens >= budget.maxOutputTokens) {
    return 'output_tokens';
  }
  if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) return 'cost';
  if (budget.deadlineAt !== undefined && now >= budget.deadlineAt) return 'deadline';
  return null;
}

/** Create a zeroed usage record for one run. */
export function createBudgetUsage(now: number = Date.now()): AgentBudgetUsage {
  return {
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: now,
  };
}
