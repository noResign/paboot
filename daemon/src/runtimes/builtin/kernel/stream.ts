import { LlmRequestError } from '../../../llm/errors.js';
import type { FinishReason, LlmChunk, LlmToolCall, Usage } from '../../../llm/types.js';
import type { AgentEventSink } from '../types.js';

export interface AssistantStreamResult {
  text: string;
  reasoning: string;
  toolCalls: LlmToolCall[];
  usage: Usage | null;
  contextTokens: number | null;
  finishReason: FinishReason;
  rawFinishReason?: string;
}

/** Consume one model stream, forward visible deltas, and assemble the step. */
export async function consumeAssistantStream(
  chunks: AsyncIterable<LlmChunk>,
  events: AgentEventSink,
): Promise<AssistantStreamResult> {
  let text = '';
  let reasoning = '';
  let sawReasoning = false;
  let usage: Usage | null = null;
  let contextTokens: number | null = null;
  let finishReason: FinishReason | null = null;
  let rawFinishReason: string | undefined;
  const tools = new Map<number, LlmToolCall>();

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text_delta':
        text += chunk.text;
        events.emit({ type: 'text_delta', delta: chunk.text });
        break;
      case 'reasoning_delta':
        if (!sawReasoning) {
          sawReasoning = true;
          events.emit({ type: 'thinking_start' });
        }
        reasoning += chunk.text;
        events.emit({ type: 'thinking_delta', delta: chunk.text });
        break;
      case 'tool_call_start':
        tools.set(chunk.index, { id: chunk.id, name: chunk.name, arguments: '' });
        break;
      case 'tool_call_delta': {
        const tool = tools.get(chunk.index);
        if (tool) tool.arguments += chunk.argsDelta;
        break;
      }
      case 'usage':
        usage = chunk.usage;
        contextTokens = chunk.contextTokens;
        break;
      case 'finish':
        finishReason = chunk.reason;
        rawFinishReason = chunk.rawReason;
        break;
    }
  }

  if (finishReason === null) {
    throw new LlmRequestError('stream_incomplete', 'model stream ended without a finish reason', {
      retryable: false,
    });
  }
  return {
    text,
    reasoning,
    toolCalls: [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tool]) => tool),
    usage,
    contextTokens,
    finishReason,
    ...(rawFinishReason ? { rawFinishReason } : {}),
  };
}
