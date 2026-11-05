import { sanitizeErrorMessage } from '../../../llm/errors.js';
import type { LlmProvider, LlmRequest, ToolSchema } from '../../../llm/types.js';
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
import { consumeAssistantStream } from './stream.js';

export interface AgentKernelDeps {
  provider: LlmProvider;
  model: string;
  modelSnapshot: ModelSnapshot;
  threadId: string;
  transcript: TranscriptStore;
  toolDescriptors: readonly ToolDescriptor[];
  toolExecutor: ToolExecutor;
  assembleContext: (tools: readonly ToolDescriptor[]) => Promise<AgentContextAssembly>;
  resolveImage?: TranscriptImageResolver;
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

        const step = await consumeAssistantStream(this.deps.provider.stream(request), agent.eventSink);
        usage.steps += 1;
        if (step.usage) {
          usage.inputTokens += step.usage.inputTokens;
          usage.outputTokens += step.usage.outputTokens;
          usage.costUsd += step.usage.costUsd ?? 0;
          agent.eventSink.emit({
            type: 'usage',
            usage: step.usage,
            costUsd: step.usage.costUsd ?? null,
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
            usage: step.usage,
          });
        }

        if (step.toolCalls.length === 0) {
          emitTurnEnd(agent.eventSink, step.finishReason);
          return { status: 'succeeded', error: null };
        }

        const afterStepBudget = budgetExhaustedReason(agent.budget, usage);
        if (afterStepBudget && afterStepBudget !== 'tool_calls') {
          for (const call of step.toolCalls) {
            this.persistSyntheticToolResult(
              agent,
              call,
              `agent budget exceeded before tool execution: ${afterStepBudget}`,
              usage.steps,
            );
          }
          emitTurnEnd(agent.eventSink, `budget_exceeded:${afterStepBudget}`);
          return { status: 'failed', error: `agent budget exceeded: ${afterStepBudget}` };
        }

        for (const call of step.toolCalls) {
          if (agent.signal.aborted) {
            emitTurnEnd(agent.eventSink, 'cancelled');
            return { status: 'cancelled', error: 'cancelled' };
          }
          if (usage.toolCalls >= agent.budget.maxToolCalls) {
            this.persistSyntheticToolResult(
              agent,
              call,
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
