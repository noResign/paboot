import { sanitizeErrorMessage } from '../../../llm/errors.js';
import { truncateToTokens } from '../tokens.js';
import type { AgentRunContext, ToolDescriptor } from '../types.js';
import { defaultToolApprovalPolicy, type ToolApprovalPolicy } from './policy.js';
import type { ToolRegistry } from './registry.js';
import type { ToolCallRequest, ToolResult } from './types.js';
import { ToolNotFoundError } from './types.js';

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  policy?: ToolApprovalPolicy;
  /** Fallback when a descriptor does not set timeoutMs. */
  defaultTimeoutMs?: number;
  /** Model-visible tool result cap; applied before the event and transcript. */
  maxResultTokens?: number;
  measure?: (text: string) => number;
  /** Upper bound for concurrent calls in one all-safe batch. */
  maxParallel?: number;
}

/**
 * Executes one tool call through the common pipeline:
 * tool_use event -> approval -> timeout/abort-aware call -> tool_result event.
 * Every started tool call receives exactly one result, including denials and
 * cancellations.
 */
export class ToolExecutor {
  private readonly policy: ToolApprovalPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly maxResultTokens: number | undefined;
  private readonly measure: ((text: string) => number) | undefined;
  private readonly maxParallel: number;

  constructor(private readonly options: ToolExecutorOptions) {
    this.policy = options.policy ?? defaultToolApprovalPolicy;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxResultTokens = options.maxResultTokens;
    this.measure = options.measure;
    this.maxParallel = options.maxParallel ?? 4;
  }

  async execute(call: ToolCallRequest, agent: AgentRunContext): Promise<ToolResult> {
    agent.eventSink.emit({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    });

    let result: ToolResult;
    try {
      const descriptor = await this.options.registry.get({ agent, signal: agent.signal }, call.name);
      if (!descriptor) throw new ToolNotFoundError(call.name);
      result = await this.executeDescriptor(descriptor, call, agent);
    } catch (error) {
      result = {
        content: sanitizeToolError(error),
        isError: true,
      };
    }
    result = this.clampResult(result);

    agent.eventSink.emit({
      type: 'tool_result',
      toolUseId: call.id,
      content: result.content,
      isError: result.isError,
      ...(result.interrupted ? { interrupted: true } : {}),
    });
    return result;
  }

  /**
   * Run one step's tool calls. A batch runs concurrently only when every
   * descriptor is `concurrencySafe`; otherwise the whole batch stays ordered
   * (a write or shell command must not race a read). Results keep the model's
   * call order regardless of completion order.
   */
  async executeBatch(
    calls: readonly ToolCallRequest[],
    agent: AgentRunContext,
  ): Promise<ToolResult[]> {
    if (calls.length === 0) return [];
    let descriptors: Awaited<ReturnType<ToolRegistry['get']>>[];
    try {
      descriptors = await Promise.all(
        calls.map((call) => this.options.registry.get({ agent, signal: agent.signal }, call.name)),
      );
    } catch {
      // Registry lookup failures must not skip results; the serial path turns
      // them into per-call error results.
      descriptors = [];
    }
    const parallel =
      descriptors.length === calls.length &&
      descriptors.every((descriptor) => descriptor?.concurrencySafe === true);
    if (!parallel) {
      const results: ToolResult[] = [];
      for (const call of calls) results.push(await this.execute(call, agent));
      return results;
    }

    const results = new Array<ToolResult>(calls.length);
    for (let start = 0; start < calls.length; start += this.maxParallel) {
      const chunk = calls.slice(start, start + this.maxParallel);
      await Promise.all(
        chunk.map(async (call, offset) => {
          results[start + offset] = await this.execute(call, agent);
        }),
      );
    }
    return results;
  }

  async close(): Promise<void> {
    await this.options.registry.close();
  }

  private clampResult(result: ToolResult): ToolResult {
    if (this.maxResultTokens === undefined) return result;
    const content = truncateToTokens(result.content, this.maxResultTokens, {
      ...(this.measure === undefined ? {} : { measure: this.measure }),
      headRatio: 0.75,
      marker: `\n\n[... tool result truncated to fit the ${this.maxResultTokens}-token budget ...]\n\n`,
    });
    return content === result.content ? result : { ...result, content };
  }

  private async executeDescriptor(
    descriptor: ToolDescriptor,
    call: ToolCallRequest,
    agent: AgentRunContext,
  ): Promise<ToolResult> {
    if (agent.signal.aborted) return interruptedResult('run cancelled before tool start');

    const decision = this.policy.decide({ descriptor, input: call.input, agent });
    if (decision === 'deny') {
      return { content: 'tool call denied by policy', isError: true };
    }
    if (decision === 'ask') {
      const approved = await this.requestApproval(descriptor, call, agent);
      if (approved !== 'allowed') {
        if (approved === 'cancelled') return interruptedResult('run cancelled while waiting for approval');
        return {
          content:
            approved === 'timed_out'
              ? 'tool approval timed out'
              : 'tool call was not approved',
          isError: true,
        };
      }
    }

    return this.executeWithLimits(descriptor, call, agent);
  }

  private async requestApproval(
    descriptor: ToolDescriptor,
    call: ToolCallRequest,
    agent: AgentRunContext,
  ): Promise<'allowed' | 'denied' | 'timed_out' | 'cancelled'> {
    if (agent.signal.aborted) return 'cancelled';
    const request = agent.permissionBroker.request({
      runId: agent.runId,
      sessionId: agent.sessionId,
      toolName: descriptor.name,
      toolInput: call.input,
    });
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      onAbort = () => resolve('cancelled');
      if (agent.signal.aborted) {
        resolve('cancelled');
        return;
      }
      agent.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        request.then((decision) => decision.status),
        cancelled,
      ]);
    } finally {
      if (onAbort) agent.signal.removeEventListener('abort', onAbort);
    }
  }

  private async executeWithLimits(
    descriptor: ToolDescriptor,
    call: ToolCallRequest,
    agent: AgentRunContext,
  ): Promise<ToolResult> {
    const timeoutMs = descriptor.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    agent.signal.addEventListener('abort', onParentAbort, { once: true });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({
          content: `tool timed out after ${timeoutMs}ms`,
          isError: true,
        });
      }, timeoutMs);
      timer.unref?.();
    });
    let onCancelledAbort: (() => void) | undefined;
    const cancelled = new Promise<ToolResult>((resolve) => {
      onCancelledAbort = () => resolve(interruptedResult('run cancelled during tool execution'));
      if (agent.signal.aborted) {
        resolve(interruptedResult('run cancelled during tool execution'));
        return;
      }
      agent.signal.addEventListener('abort', onCancelledAbort, { once: true });
    });

    try {
      const execution = Promise.resolve(
        this.options.registry.call(
          { agent, signal: controller.signal, callId: call.id },
          call.name,
          call.input,
        ),
      );
      const result = await Promise.race([execution, timeout, cancelled]);
      if (timedOut) return result;
      if (agent.signal.aborted) return interruptedResult('run cancelled during tool execution');
      return result;
    } catch (error) {
      return {
        content: sanitizeToolError(error),
        isError: true,
      };
    } finally {
      if (timer) clearTimeout(timer);
      agent.signal.removeEventListener('abort', onParentAbort);
      if (onCancelledAbort) agent.signal.removeEventListener('abort', onCancelledAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}

function interruptedResult(content: string): ToolResult {
  return { content, isError: true, interrupted: true };
}

function sanitizeToolError(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}
