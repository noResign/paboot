import type { AgentBudget, AgentBudgetUsage, BudgetExhaustedReason } from './types.js';

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
