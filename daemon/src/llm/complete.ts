import type { LlmChunk, LlmCompletion, LlmToolCall, FinishReason, Usage } from './types.js';

/** Aggregate a provider stream into the tool-free `complete()` contract. */
export async function aggregateCompletion(
  chunks: AsyncIterable<LlmChunk>,
): Promise<LlmCompletion> {
  let text = '';
  let reasoning = '';
  let usage: Usage | null = null;
  let finishReason: FinishReason = 'error';
  let rawFinishReason: string | undefined;
  const tools = new Map<number, LlmToolCall>();

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text_delta':
        text += chunk.text;
        break;
      case 'reasoning_delta':
        reasoning += chunk.text;
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
        break;
      case 'finish':
        finishReason = chunk.reason;
        rawFinishReason = chunk.rawReason;
        break;
    }
  }

  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    toolCalls: [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tool]) => tool),
    finishReason,
    ...(rawFinishReason ? { rawFinishReason } : {}),
    usage,
  };
}
