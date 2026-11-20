import { sanitizeErrorMessage } from '../../../llm/errors.js';
import type { ModelPrice } from '../../../llm/catalog.js';
import type {
  FinishReason,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmSystemPart,
  ToolSchema,
  Usage,
} from '../../../llm/types.js';
import type { NativeCompaction } from '../../../types/transcript.js';
import type { AgentContextAssembly } from '../context/assembly.js';
import type { PromptCompileResult } from '../prompt.js';
import {
  findKeepBoundary,
  planCompaction,
  type CompactionPlan,
  type CompactionSettings,
} from '../compact.js';
import type { TranscriptStore } from '../transcript/store.js';
import {
  renderTranscriptMessages,
  type TranscriptImageResolver,
} from '../transcript/render.js';
import {
  budgetExhaustedReason,
  createBudgetUsage,
} from '../budget.js';
import type {
  AgentEventSink,
  AgentRunContext,
  ModelSnapshot,
  ToolDescriptor,
} from '../types.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolCallRequest, ToolResult } from '../tools/types.js';
import { estimateRequestTokens, type TokenCalibrator } from '../tokens.js';
import { consumeAssistantStream, type AssistantStreamResult } from './stream.js';

/** One model step, exposed for the live debug page (no persistence). */
export interface KernelStepDebugRecord {
  runId: string;
  step: number;
  provider: string;
  model: string;
  request: LlmRequest;
  context: AgentContextAssembly;
  estimatedTokens: number;
}

/** Outcome of one model step, recorded after the stream settles. */
export interface KernelStepDebugResult {
  runId: string;
  step: number;
  status: 'ok' | 'error' | 'cancelled';
  durationMs: number;
  finishReason?: FinishReason;
  rawFinishReason?: string;
  usage?: Usage | null;
  textChars: number;
  reasoningChars: number;
  toolCallCount: number;
  /** Short assistant text preview; never the full response. */
  preview?: string;
  error?: { code?: string; message: string };
}

export interface AgentKernelDeps {
  provider: LlmProvider;
  model: string;
  modelSnapshot: ModelSnapshot;
  threadId: string;
  transcript: TranscriptStore;
  toolDescriptors: readonly ToolDescriptor[];
  toolExecutor: ToolExecutor;
  assembleContext: (tools: readonly ToolDescriptor[]) => Promise<AgentContextAssembly>;
  /** Learns this model's real token density from provider usage. */
  tokenCalibrator: TokenCalibrator;
  /** Automatic history compaction; omit to disable. */
  compaction?: {
    settings: CompactionSettings;
    /** Window used when the provider catalogue has no contextWindow. */
    contextWindow: number;
    /** Persist a summary for one plan; null keeps the history uncompacted. */
    summarize: (
      plan: CompactionPlan,
      previous: NativeCompaction | null,
      signal: AbortSignal,
    ) => Promise<NativeCompaction | null>;
  };
  resolveImage?: TranscriptImageResolver;
  /** [debug] Debug observability; failures never break the run. */
  debugStep?: (record: KernelStepDebugRecord) => void;
  debugStepResult?: (result: KernelStepDebugResult) => void;
}

export interface AgentKernelResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  error: string | null;
}

/** One turn of the builtin agent: model steps + tool execution until stop. */
export class AgentKernel {
  constructor(private readonly deps: AgentKernelDeps) {}

  async run(agent: AgentRunContext): Promise<AgentKernelResult> {
    const usage = createBudgetUsage();
    const toolSchemas = this.deps.modelSnapshot.supportsTools
      ? this.deps.toolDescriptors.map(toToolSchema)
      : [];
    const price = this.deps.modelSnapshot.price;
    let sawCost = false;
    // `usage` is the cumulative per-run total on the wire; the transcript keeps
    // each model step's own usage separately for history/debugging.
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let hasUsage = false;
    let lastContextTokens: number | null = null;
    let lastContextWindow: number | null = null;

    try {
      for (;;) {
        if (agent.signal.aborted) {
          emitTurnEnd(agent.eventSink, 'cancelled');
          return { status: 'cancelled', error: 'cancelled' };
        }
        const exhausted = budgetExhaustedReason(agent.budget, usage);
        if (exhausted) {
          emitTurnEnd(agent.eventSink, `budget_exceeded:${exhausted}`);
          return { status: 'failed', error: `agent budget exceeded: ${exhausted}` };
        }

        const context = await this.deps.assembleContext(this.deps.toolDescriptors);
        const loaded = await this.loadMessages(
          context,
          toolSchemas,
          lastContextTokens,
          agent.signal,
        );
        const messages = loaded.messages;
        const systemText = withRuntimeContext(context, loaded.summary);
        const systemParts = buildSystemParts(context, loaded.summary);

        if (loaded.compacted) {
          agent.eventSink.emit({
            type: 'context_compacted',
            beforeTokens: loaded.compacted.beforeTokens,
            afterTokens: loaded.compacted.afterTokens,
          });
        }

        agent.eventSink.emit({
          type: 'status',
          label: 'working',
          model: `${this.deps.provider.id}:${this.deps.model}`,
          sessionId: agent.sessionId ?? null,
          runtime: 'builtin',
        });

        const request: LlmRequest = {
          provider: this.deps.provider.id,
          model: this.deps.model,
          system: systemText,
          ...(systemParts.length > 0 ? { systemParts } : {}),
          messages,
          tools: toolSchemas,
          ...(this.deps.modelSnapshot.maxOutput ? { maxTokens: this.deps.modelSnapshot.maxOutput } : {}),
          signal: agent.signal,
        };
        const requestEstimate = estimateRequestTokens({
          system: systemText,
          messages,
          tools: toolSchemas,
        });
        // [debug] snapshot the exact model request for the live page
        const stepNumber = usage.steps + 1;
        if (this.deps.debugStep) {
          try {
            this.deps.debugStep({
              runId: agent.runId,
              step: stepNumber,
              provider: this.deps.provider.id,
              model: this.deps.model,
              request,
              context,
              estimatedTokens: requestEstimate.tokens,
            });
          } catch {
            // Debug capture must never break the model call.
          }
        }

        const startedAt = Date.now();
        let step: AssistantStreamResult;
        try {
          step = await consumeAssistantStream(this.deps.provider.stream(request), agent.eventSink);
        } catch (err) {
          this.emitStepResult({
            runId: agent.runId,
            step: stepNumber,
            status: agent.signal.aborted ? 'cancelled' : 'error',
            durationMs: Date.now() - startedAt,
            textChars: 0,
            reasoningChars: 0,
            toolCallCount: 0,
            error: {
              ...(readErrorCode(err) ? { code: readErrorCode(err) } : {}),
              message: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
            },
          });
          throw err;
        }
        this.emitStepResult({
          runId: agent.runId,
          step: stepNumber,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          finishReason: step.finishReason,
          ...(step.rawFinishReason ? { rawFinishReason: step.rawFinishReason } : {}),
          usage: step.usage,
          textChars: step.text.length,
          reasoningChars: step.reasoning.length,
          toolCallCount: step.toolCalls.length,
          ...(step.text ? { preview: step.text.slice(0, 500) } : {}),
        });
        usage.steps += 1;
        let stepCostUsd: number | null = null;
        if (step.usage) {
          hasUsage = true;
          usage.inputTokens += step.usage.inputTokens;
          usage.outputTokens += step.usage.outputTokens;
          totalUsage.inputTokens += step.usage.inputTokens;
          totalUsage.outputTokens += step.usage.outputTokens;
          if (step.usage.cacheReadTokens !== undefined) {
            totalUsage.cacheReadTokens =
              (totalUsage.cacheReadTokens ?? 0) + step.usage.cacheReadTokens;
          }
          if (step.usage.cacheWriteTokens !== undefined) {
            totalUsage.cacheWriteTokens =
              (totalUsage.cacheWriteTokens ?? 0) + step.usage.cacheWriteTokens;
          }
          stepCostUsd = costOfUsage(step.usage, price);
          if (stepCostUsd !== null) {
            usage.costUsd += stepCostUsd;
            sawCost = true;
          }
          this.deps.tokenCalibrator.observe(
            step.contextTokens ??
              step.usage.inputTokens +
                (step.usage.cacheReadTokens ?? 0) +
                (step.usage.cacheWriteTokens ?? 0),
            requestEstimate,
          );
          // Mid-run we refresh only the context indicator. The usage line is the
          // run's final total, emitted once when the turn ends — the same timing
          // as Claude (result frame) and Codex (turn/completed), so the token
          // counter does not tick up while the agent is still calling tools.
          lastContextTokens = step.contextTokens ?? null;
          lastContextWindow = this.deps.modelSnapshot.contextWindow ?? null;
          agent.eventSink.emit({
            type: 'usage',
            usage: null,
            ...(step.contextTokens !== null
              ? { contextTokens: step.contextTokens, contextWindow: lastContextWindow }
              : {}),
          });
        }

        const assistantBlocks = [
          ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
          ...(step.reasoning
            ? [{ type: 'reasoning' as const, text: step.reasoning, provider: this.deps.provider.id }]
            : []),
          ...step.toolCalls.map((call) => ({
            type: 'tool_call' as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ];
        if (assistantBlocks.length > 0) {
          this.deps.transcript.append({
            threadId: this.deps.threadId,
            role: 'assistant',
            blocks: assistantBlocks,
            source: { kind: 'model', provider: this.deps.provider.id, model: this.deps.model },
            runId: agent.runId,
            step: usage.steps,
            provider: this.deps.provider.id,
            model: this.deps.model,
            usage: step.usage
              ? { ...step.usage, ...(stepCostUsd === null ? {} : { costUsd: stepCostUsd }) }
              : undefined,
          });
        }

        if (step.toolCalls.length === 0) {
          agent.eventSink.emit({
            type: 'usage',
            usage: hasUsage ? wireUsage(totalUsage) : null,
            // The wire contract is a per-run cumulative cost, not this step's.
            costUsd: sawCost ? usage.costUsd : null,
            stopReason: step.finishReason,
            ...(lastContextTokens !== null ? { contextTokens: lastContextTokens } : {}),
            contextWindow: lastContextWindow,
          });
          emitTurnEnd(agent.eventSink, step.finishReason);
          return { status: 'succeeded', error: null };
        }

        const afterStepBudget = budgetExhaustedReason(agent.budget, usage);
        if (afterStepBudget && afterStepBudget !== 'tool_calls') {
          this.persistMissingToolResults(
            agent,
            step.toolCalls,
            `agent budget exceeded before tool execution: ${afterStepBudget}`,
            usage.steps,
          );
          emitTurnEnd(agent.eventSink, `budget_exceeded:${afterStepBudget}`);
          return { status: 'failed', error: `agent budget exceeded: ${afterStepBudget}` };
        }

        // Fast path: a fully parsed batch that fits the budget goes through the
        // executor once. Concurrency-safe reads run in parallel; any write /
        // execute call keeps the whole batch ordered inside executeBatch.
        const parsedCalls = step.toolCalls.map((call) => parseToolInput(call.arguments));
        const batchFitsBudget =
          agent.budget.maxToolCalls - usage.toolCalls >= step.toolCalls.length;
        if (!agent.signal.aborted && batchFitsBudget && parsedCalls.every((parsed) => parsed.ok)) {
          usage.toolCalls += step.toolCalls.length;
          const calls = step.toolCalls.map((call, index) => ({
            id: call.id,
            name: call.name,
            input: (parsedCalls[index] as { ok: true; input: unknown }).input,
          }));
          const results = await this.deps.toolExecutor.executeBatch(calls, agent);
          for (let index = 0; index < results.length; index += 1) {
            this.appendToolResult(agent, calls[index]!.id, results[index]!, usage.steps);
          }
          if (agent.signal.aborted || results.some((result) => result.interrupted)) {
            emitTurnEnd(agent.eventSink, 'cancelled');
            return { status: 'cancelled', error: 'cancelled' };
          }
          continue;
        }

        for (let index = 0; index < step.toolCalls.length; index += 1) {
          const call = step.toolCalls[index]!;
          if (agent.signal.aborted) {
            this.persistMissingToolResults(
              agent,
              step.toolCalls.slice(index),
              'run cancelled before this tool started',
              usage.steps,
            );
            emitTurnEnd(agent.eventSink, 'cancelled');
            return { status: 'cancelled', error: 'cancelled' };
          }
          if (usage.toolCalls >= agent.budget.maxToolCalls) {
            this.persistMissingToolResults(
              agent,
              step.toolCalls.slice(index),
              'agent budget exceeded before tool execution: tool_calls',
              usage.steps,
            );
            emitTurnEnd(agent.eventSink, 'budget_exceeded:tool_calls');
            return { status: 'failed', error: 'agent budget exceeded: tool_calls' };
          }
          usage.toolCalls += 1;
          const parsed = parseToolInput(call.arguments);
          let result: ToolResult;
          if (!parsed.ok) {
            agent.eventSink.emit({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: call.arguments,
            });
            result = {
              content: `invalid tool arguments JSON: ${parsed.error}`,
              isError: true,
            };
            agent.eventSink.emit({
              type: 'tool_result',
              toolUseId: call.id,
              content: result.content,
              isError: true,
            });
          } else {
            result = await this.deps.toolExecutor.execute(
              { id: call.id, name: call.name, input: parsed.input },
              agent,
            );
          }
          this.appendToolResult(agent, call.id, result, usage.steps);
          if (result.interrupted || agent.signal.aborted) {
            // The assistant message already contains every tool call in this
            // batch. Any call that never produced a result must still get one,
            // otherwise the next provider request rejects the transcript.
            this.persistMissingToolResults(
              agent,
              step.toolCalls.slice(index + 1),
              'run cancelled before this tool started',
              usage.steps,
            );
            emitTurnEnd(agent.eventSink, 'cancelled');
            return { status: 'cancelled', error: 'cancelled' };
          }
        }
      }
    } catch (error) {
      if (agent.signal.aborted) {
        emitTurnEnd(agent.eventSink, 'cancelled');
        return { status: 'cancelled', error: 'cancelled' };
      }
      return {
        status: 'failed',
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  /** [debug] Record the step outcome; a broken sink never affects the run. */
  private emitStepResult(result: KernelStepDebugResult): void {
    if (!this.deps.debugStepResult) return;
    try {
      this.deps.debugStepResult(result);
    } catch {
      // Debug capture must never break the run.
    }
  }

  private renderOptions(prune?: {
    pruneToolResultsThroughSeq: number;
    toolResultKeepBytes: number;
  }): Parameters<typeof renderTranscriptMessages>[1] {
    return {
      supportsImages: this.deps.modelSnapshot.supportsImages,
      ...(this.deps.resolveImage ? { resolveImage: this.deps.resolveImage } : {}),
      ...(prune ?? {}),
    };
  }

  /**
   * Load the transcript for the next model call, compacting it first when the
   * context is near the window. Compaction is best-effort and mutates only the
   * compaction table; the raw transcript stays append-only.
   */
  private async loadMessages(
    context: AgentContextAssembly,
    tools: readonly ToolSchema[],
    lastContextTokens: number | null,
    signal: AbortSignal,
  ): Promise<{
    messages: LlmMessage[];
    summary: string | null;
    compacted?: { beforeTokens: number; afterTokens: number };
  }> {
    const compaction = this.deps.compaction;
    if (!compaction) {
      return {
        messages: await renderTranscriptMessages(
          this.deps.transcript.list(this.deps.threadId),
          this.renderOptions(),
        ),
        summary: null,
      };
    }

    const read = async (boundary: number, pruneThrough: number | null): Promise<LlmMessage[]> => {
      const list = this.deps.transcript.list(this.deps.threadId, boundary);
      return renderTranscriptMessages(
        list,
        this.renderOptions(
          pruneThrough === null
            ? undefined
            : {
                pruneToolResultsThroughSeq: pruneThrough,
                toolResultKeepBytes: compaction.settings.toolResultKeepBytes,
              },
        ),
      );
    };

    let latest = this.deps.transcript.listCompactions(this.deps.threadId).at(-1) ?? null;
    let messages = await read(latest?.throughSeq ?? 0, null);
    const settings = compaction.settings;
    if (!settings.enabled) return { messages, summary: latest?.summary ?? null };

    const window = this.deps.modelSnapshot.contextWindow ?? compaction.contextWindow;
    const triggerTokens = Math.floor(window * settings.triggerAt);
    const keepTokens = Math.floor(window * settings.keepRecentRatio);
    const measure = this.deps.tokenCalibrator.measure;
    const estimate = (list: LlmMessage[], summary: string | null): number =>
      estimateRequestTokens({
        system: withRuntimeContext(context, summary),
        messages: list,
        tools,
        measure,
      }).tokens;

    const triggered =
      lastContextTokens !== null
        ? lastContextTokens >= triggerTokens
        : estimate(messages, latest?.summary ?? null) >= triggerTokens;
    if (!triggered) return { messages, summary: latest?.summary ?? null };

    const baseSeq = latest?.throughSeq ?? 0;
    const active = this.deps.transcript.list(this.deps.threadId, baseSeq);
    const keep = findKeepBoundary(active, keepTokens, measure);

    // Stage 1: replace oversized old tool results; skip the summary when that
    // alone brings the request under the prune target.
    let usable = messages;
    if (settings.pruneOldToolResults && keep && keep.throughSeq > baseSeq) {
      usable = await read(baseSeq, keep.throughSeq);
      const pruneTarget = Math.floor(window * settings.toolResultPruneTarget);
      if (estimate(usable, latest?.summary ?? null) <= pruneTarget) {
        return { messages: usable, summary: latest?.summary ?? null };
      }
    }

    // Stage 2: summarize the older prefix.
    const plan = planCompaction(active, keepTokens, settings.minCompactTokens, measure);
    if (!plan) return { messages: usable, summary: latest?.summary ?? null };
    const written = await compaction.summarize(plan, latest, signal);
    if (!written) return { messages: usable, summary: latest?.summary ?? null };

    const beforeTokens =
      lastContextTokens ?? estimate(messages, latest?.summary ?? null);
    latest = written;
    messages = await read(written.throughSeq, null);
    return {
      messages,
      summary: written.summary,
      compacted: {
        beforeTokens: Math.max(0, Math.round(beforeTokens)),
        afterTokens: Math.max(0, Math.round(estimate(messages, written.summary))),
      },
    };
  }

  private appendToolResult(
    agent: AgentRunContext,
    callId: string,
    result: ToolResult,
    step: number,
  ): void {
    this.deps.transcript.append({
      threadId: this.deps.threadId,
      role: 'tool',
      blocks: [{
        type: 'tool_result',
        toolUseId: callId,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      }],
      source: { kind: 'tool', callId },
      runId: agent.runId,
      step,
    });
  }

  private persistMissingToolResults(
    agent: AgentRunContext,
    calls: readonly { id: string; name: string; arguments: string }[],
    reason: string,
    step: number,
  ): void {
    for (const call of calls) {
      this.persistSyntheticToolResult(agent, call, `tool call was not executed: ${reason}`, step);
    }
  }

  private persistSyntheticToolResult(
    agent: AgentRunContext,
    call: { id: string; name: string; arguments: string },
    content: string,
    step: number,
  ): void {
    agent.eventSink.emit({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    const result: ToolResult = { content, isError: true, interrupted: true };
    agent.eventSink.emit({
      type: 'tool_result',
      toolUseId: call.id,
      content,
      isError: true,
      interrupted: true,
    });
    this.appendToolResult(agent, call.id, result, step);
  }
}

function withSummary(system: string, summary: string | null): string {
  if (!summary) return system;
  const block = `## Earlier conversation summary\n${summary}`;
  return system.trim() ? `${system}\n\n${block}` : block;
}

/**
 * Runtime context (environment / docs / knowledge / skills / memory index)
 * belongs to the system channel now, not to a user-role transcript message.
 */
function withRuntimeContext(
  context: AgentContextAssembly,
  summary: string | null,
): string {
  const combined = [context.system.text, context.runtimeContext.text.trim()]
    .filter((text) => text.length > 0)
    .join('\n\n');
  return withSummary(combined, summary);
}

/**
 * Split system text into stable/dynamic parts, but do NOT mark a cache
 * breakpoint for now (explicit prompt caching is intentionally opt-in later).
 */
function buildSystemParts(
  context: AgentContextAssembly,
  summary: string | null,
): LlmSystemPart[] {
  const parts: LlmSystemPart[] = [];
  const stable = [context.system.stableText, context.runtimeContext.text.trim()]
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
  if (stable) parts.push({ text: stable });
  const dynamic = [
    context.system.dynamicText,
    summary ? `## Earlier conversation summary\n${summary}` : '',
  ]
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
  if (dynamic) parts.push({ text: dynamic });
  return parts;
}

function readErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function toToolSchema(tool: ToolDescriptor): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function parseToolInput(raw: string): { ok: true; input: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, input: raw.trim() ? JSON.parse(raw) : {} };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function emitTurnEnd(events: AgentEventSink, stopReason: string): void {
  events.emit({ type: 'turn_end', stopReason });
}

/** Cost for one model step from the catalog price, or null when unknown. */
function costOfUsage(usage: Usage, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const inputTokens =
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return (
    (inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) /
    1_000_000
  );
}

/** The wire `usage` blob other runtimes already emit (snake_case). */
function wireUsage(usage: Usage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cache_creation_input_tokens: usage.cacheWriteTokens }),
  };
}
