import { redactDeep } from './redact.js';
import type {
  BuiltinStepCaptureInput,
  MemoryExtractionCaptureInput,
  Redactor,
  RunInjectionCaptureInput,
} from './types.js';

/** Shape shown in the debug page for one run's paboot-side injection. */
export function buildRunInjectionPayload(
  input: RunInjectionCaptureInput,
  redactor: Redactor,
): Record<string, unknown> {
  return {
    version: 1,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    runtime: input.runtime,
    sessionKind: input.sessionKind,
    purpose: input.purpose,
    memoryMode: input.memoryMode,
    model: input.model,
    modelParameters: input.modelParameters,
    permissionMode: input.permissionMode,
    extraDirs: input.extraDirs,
    resumeNativeSession: input.resumeNativeSession,
    injectionMode: input.injectionMode,
    prompt: redactor.text(input.prompt),
    promptSent: redactor.text(input.promptSent),
    systemContext: input.systemContext === null ? null : redactor.text(input.systemContext),
    toolServers: redactor.toolServers(input.toolServers),
    knowledge: input.knowledge === null ? null : withText(input.knowledge, redactor),
    memory: input.memory === null ? null : withText(input.memory, redactor),
    recall: input.recall === null ? null : withText(input.recall, redactor),
    merged: input.merged === null ? null : withText(input.merged, redactor),
  };
}

/** Full model request for one builtin step, plus the assembled context channels. */
export function buildBuiltinStepPayload(
  input: BuiltinStepCaptureInput,
  redactor: Redactor,
): Record<string, unknown> {
  const { assembly } = input;
  return {
    version: 1,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    step: input.step,
    provider: input.provider,
    model: input.model,
    agentId: assembly.agentId,
    presetId: assembly.presetId,
    presetVersion: assembly.presetVersion,
    contextVersion: assembly.contextVersion,
    system: redactor.text(input.request.system),
    systemStable: redactor.text(assembly.system.stableText),
    systemDynamic: redactor.text(assembly.system.dynamicText),
    systemSections: assembly.system.sections.map((section) => ({
      id: section.id,
      order: section.order,
      stability: section.stability,
      trust: section.trust,
      text: redactor.text(section.text),
    })),
    systemOmitted: assembly.system.omitted,
    systemOverBudget: assembly.system.overBudget,
    systemVersion: assembly.system.version,
    runtimeContext: {
      text: redactor.text(assembly.runtimeContext.text),
      contributions: assembly.runtimeContext.contributions.map((item) => ({
        source: item.source,
        kind: item.kind,
        stability: item.stability,
        trust: item.trust,
        priority: item.priority,
        content: redactor.text(item.content),
      })),
      omitted: assembly.runtimeContext.omitted,
      overBudget: assembly.runtimeContext.overBudget,
      version: assembly.runtimeContext.version,
    },
    messages: redactor.messages(input.request.messages),
    tools: input.request.tools.map((tool) => ({
      name: tool.name,
      description: redactor.text(tool.description),
      inputSchema: tool.inputSchema,
    })),
    maxTokens: input.request.maxTokens ?? null,
    temperature: input.request.temperature ?? null,
    estimatedTokens: input.estimatedTokens,
    wireBody: input.wireBody === undefined ? null : redactDeep(input.wireBody, redactor),
  };
}

/** One background memory-extraction model call (success or failure). */
export function buildMemoryExtractionPayload(
  input: MemoryExtractionCaptureInput,
  redactor: Redactor,
): Record<string, unknown> {
  const completion = input.completion ?? null;
  return {
    version: 1,
    batchKey: input.batchKey,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    provider: input.provider,
    model: input.model,
    workspaceId: input.workspaceId,
    scope: input.scope,
    sessionId: input.sessionId,
    runId: input.runId,
    sourceIds: input.sourceIds,
    system: redactor.text(input.request.system),
    user: redactor.text(messageText(input.request.messages)),
    maxTokens: input.request.maxTokens ?? null,
    temperature: input.request.temperature ?? null,
    response: completion === null ? null : redactor.text(completion.text),
    reasoning: completion?.reasoning ? redactor.text(completion.reasoning) : null,
    usage: completion?.usage ?? null,
    finishReason: completion?.finishReason ?? null,
    rawFinishReason: completion?.rawFinishReason ?? null,
    durationMs: input.durationMs,
    error: input.error ? redactor.text(input.error) : null,
    deterministic: input.deterministic,
    willRetry: input.willRetry,
    failureState: input.failureState ?? null,
  };
}

function withText<T extends { prefix: string }>(value: T, redactor: Redactor): Record<string, unknown> {
  return { ...value, prefix: redactor.text(value.prefix) };
}

function messageText(messages: ReadonlyArray<{ content: string | ReadonlyArray<unknown> }>): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (isTextBlock(block)) parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}
