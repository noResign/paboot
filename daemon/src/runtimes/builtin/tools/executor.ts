import { sanitizeErrorMessage } from '../../../llm/errors.js';
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

  constructor(private readonly options: ToolExecutorOptions) {
    this.policy = options.policy ?? defaultToolApprovalPolicy;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
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

    agent.eventSink.emit({
      type: 'tool_result',
      toolUseId: call.id,
      content: result.content,
      isError: result.isError,
      ...(result.interrupted ? { interrupted: true } : {}),
    });
    return result;
  }

  async close(): Promise<void> {
    await this.options.registry.close();
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
