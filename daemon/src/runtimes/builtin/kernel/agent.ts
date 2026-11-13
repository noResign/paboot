import { sanitizeErrorMessage } from '../../../llm/errors.js';
import type { ModelPrice } from '../../../llm/catalog.js';
import type { FinishReason, LlmProvider, LlmRequest, ToolSchema, Usage } from '../../../llm/types.js';
import type { AgentContextAssembly } from '../context/assembly.js';
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
        await this.persistRuntimeContext(agent, context);
        const messages = await renderTranscriptMessages(
          this.deps.transcript.list(this.deps.threadId),
          {
            supportsImages: this.deps.modelSnapshot.supportsImages,
            resolveImage: this.deps.resolveImage,
          },
        );

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
          system: context.system.text,
          messages,
          tools: toolSchemas,
          ...(this.deps.modelSnapshot.maxOutput ? { maxTokens: this.deps.modelSnapshot.maxOutput } : {}),
          signal: agent.signal,
        };
        const requestEstimate = estimateRequestTokens({
          system: context.system.text,
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
          agent.eventSink.emit({
            type: 'usage',
            usage: wireUsage(totalUsage),
            // The wire contract is a per-run cumulative cost, not this step's.
            costUsd: sawCost ? usage.costUsd : null,
            contextTokens: step.contextTokens,
            contextWindow: this.deps.modelSnapshot.contextWindow ?? null,
            stopReason: step.finishReason,
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

  private async persistRuntimeContext(
    agent: AgentRunContext,
    context: AgentContextAssembly,
  ): Promise<void> {
    const latest = this.deps.transcript.latestContext(this.deps.threadId);
    const latestText = latest?.blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n') ?? null;
    const currentText = context.runtimeContext.text;
    if (latestText === currentText) return;
    if (currentText.length === 0 && latest === null) return;
    this.deps.transcript.append({
      threadId: this.deps.threadId,
      role: 'user',
      blocks: currentText ? [{ type: 'text', text: currentText }] : [],
      source: {
        kind: 'runtime-context',
        sourceKey: 'runtime-snapshot',
        version: context.runtimeContext.version,
        sections: context.runtimeContext.contributions.map((item) => ({
          name: item.source,
          text: item.content,
        })),
      },
      runId: agent.runId,
      step: null,
    });
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
