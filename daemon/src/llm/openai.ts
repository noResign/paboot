import { aggregateCompletion } from './complete.js';
import {
  errorFromResponse,
  LlmRequestError,
  type StreamRetryOptions,
  withStreamRetry,
} from './errors.js';
import { readSse, requestSse, type FetchLike } from './sse.js';
import type {
  FinishReason,
  LlmChunk,
  LlmCompletion,
  LlmContentBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  Usage,
} from './types.js';

export interface OpenAIProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  retry?: Omit<StreamRetryOptions, 'signal'>;
  /** Some compatible gateways reject stream_options; allow disabling usage chunks. */
  includeStreamUsage?: boolean;
  /** Older/newer gateways differ between max_tokens and max_completion_tokens. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}

const DEFAULT_MAX_TOKENS = 4_096;

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
  started: boolean;
}

export class OpenAIProvider implements LlmProvider {
  readonly kind = 'openai' as const;
  readonly available: boolean;
  readonly unavailableReason: string | undefined;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.available = options.apiKey.trim().length > 0;
    this.unavailableReason = this.available ? undefined : 'OpenAI-compatible API key is missing';
  }

  get id(): string {
    return this.options.id;
  }

  stream(request: LlmRequest): AsyncIterable<LlmChunk> {
    return withStreamRetry(() => this.streamOnce(request), {
      ...this.options.retry,
      signal: request.signal,
    });
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    return aggregateCompletion(this.stream(request));
  }

  private async *streamOnce(request: LlmRequest): AsyncGenerator<LlmChunk> {
    const url = `${trimTrailingSlash(this.options.baseUrl)}/v1/chat/completions`;
    const includeStreamUsage = this.options.includeStreamUsage ?? true;
    const send = (maxTokensField: 'max_tokens' | 'max_completion_tokens'): Promise<Response> =>
      requestSse(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(buildOpenAIBody(request, { includeStreamUsage, maxTokensField })),
        },
        {
          signal: request.signal,
          connectTimeoutMs: this.options.connectTimeoutMs,
          idleTimeoutMs: this.options.idleTimeoutMs,
          fetch: this.options.fetch,
        },
      );

    // Newer OpenAI models reject `max_tokens`; older compatible gateways reject
    // `max_completion_tokens`. Try the modern field first and fall back once when
    // a 400/422 explicitly names it — no generation has started yet.
    const primary = this.options.maxTokensField ?? 'max_completion_tokens';
    let response = await send(primary);
    if (!response.ok && primary === 'max_completion_tokens') {
      const body = await response.text().catch(() => '');
      if (
        (response.status === 400 || response.status === 422) &&
        /max_completion_tokens/i.test(body)
      ) {
        response = await send('max_tokens');
      } else {
        throw errorFromResponse(response, body);
      }
    }
    if (!response.ok) {
      throw errorFromResponse(response, await response.text().catch(() => ''));
    }

    const tools = new Map<number, PendingToolCall>();
    let finishReason: FinishReason | null = null;
    let rawFinishReason: string | null = null;
    let sawDone = false;
    let usage: Usage | null = null;
    let contextTokens: number | null = null;
    let sawAnyData = false;

    for await (const event of readSse(response, {
      signal: request.signal,
      idleTimeoutMs: this.options.idleTimeoutMs,
    })) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      if (event.data.trim() === '') continue;
      sawAnyData = true;
      const payload = parseOpenAIEvent(event.data);

      if (payload['error'] !== undefined) {
        const error = asRecord(payload['error']);
        throw new LlmRequestError(
          'provider',
          readString(error, 'message') ?? 'OpenAI-compatible stream error',
          { retryable: false },
        );
      }

      const usageRecord = asRecord(payload['usage']);
      if (usageRecord) {
        usage = openAIUsage(usageRecord);
        contextTokens =
          usage.inputTokens +
          (usage.cacheReadTokens ?? 0) +
          (usage.cacheWriteTokens ?? 0);
      }

      const choices = Array.isArray(payload['choices']) ? payload['choices'] : [];
      const choice = asRecord(choices[0]);
      if (!choice) continue;
      const delta = asRecord(choice['delta']);
      const raw = readString(choice, 'finish_reason');
      if (raw !== null) {
        rawFinishReason = raw;
        finishReason = mapOpenAIFinishReason(raw);
      }

      if (delta) {
        const text = readString(delta, 'content');
        if (text) yield { type: 'text_delta', text };
        const reasoning = readString(delta, 'reasoning_content');
        if (reasoning) yield { type: 'reasoning_delta', text: reasoning };

        const calls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
        for (const rawCall of calls) {
          const call = asRecord(rawCall);
          if (!call) continue;
          const index = readNumber(call, 'index') ?? 0;
          const fn = asRecord(call['function']);
          const pending = tools.get(index) ?? {
            index,
            id: `call_${index}`,
            name: '',
            args: '',
            started: false,
          };
          const id = readString(call, 'id');
          if (id) pending.id = id;
          const name = readString(fn, 'name');
          if (name) pending.name = name;
          const argsDelta = readString(fn, 'arguments');
          if (argsDelta) pending.args += argsDelta;
          tools.set(index, pending);

          if (!pending.started && pending.name) {
            pending.started = true;
            yield {
              type: 'tool_call_start',
              index,
              id: pending.id,
              name: pending.name,
            };
            if (pending.args) {
              yield { type: 'tool_call_delta', index, argsDelta: pending.args };
              pending.args = '';
            }
          } else if (pending.started && argsDelta) {
            yield { type: 'tool_call_delta', index, argsDelta };
          }
        }
      }
    }

    for (const tool of tools.values()) {
      if (!tool.started || !tool.name) {
        throw new LlmRequestError('protocol', 'OpenAI stream ended with an incomplete tool call');
      }
    }
    if (!sawDone && finishReason === null) {
      throw new LlmRequestError(
        'stream_incomplete',
        sawAnyData ? 'OpenAI stream ended before [DONE]' : 'OpenAI stream returned no data',
        { retryable: !sawAnyData },
      );
    }
    if (usage) {
      yield {
        type: 'usage',
        usage,
        contextTokens: contextTokens ?? usage.inputTokens,
      };
    }
    yield {
      type: 'finish',
      reason: finishReason ?? (tools.size > 0 ? 'tool_use' : 'stop'),
      ...(rawFinishReason ? { rawReason: rawFinishReason } : {}),
    };
  }
}

export function buildOpenAIBody(
  request: LlmRequest,
  options: { includeStreamUsage?: boolean; maxTokensField?: 'max_tokens' | 'max_completion_tokens' } = {},
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (request.system.trim()) {
    messages.push({ role: 'system', content: request.system });
  }
  for (const message of request.messages) {
    messages.push(...renderOpenAIMessages(message));
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
  };
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  body[options.maxTokensField ?? 'max_completion_tokens'] = maxTokens;
  if (options.includeStreamUsage !== false) {
    body['stream_options'] = { include_usage: true };
  }
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  return body;
}

function renderOpenAIMessages(message: LlmMessage): Record<string, unknown>[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }
  if (message.role === 'assistant') {
    const text = message.content
      .filter((block): block is Extract<LlmContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = message.content
      .filter((block): block is Extract<LlmContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  // OpenAI represents tool results as their own role, before any remaining user
  // content from the same neutral message.
  const out: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content: block.content,
      });
    }
  }
  const userContent = message.content
    .filter((block) => block.type !== 'tool_result')
    .map(renderOpenAIUserBlock);
  if (userContent.length > 0) out.push({ role: 'user', content: userContent });
  return out;
}

function renderOpenAIUserBlock(block: LlmContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      };
    case 'tool_use':
    case 'tool_result':
      // Handled by the assistant/tool-result branches above.
      return { type: 'text', text: '' };
  }
}

function parseOpenAIEvent(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error('event is not an object');
    return record;
  } catch (error) {
    throw new LlmRequestError('protocol', 'invalid OpenAI-compatible SSE JSON', {
      cause: error,
    });
  }
}

function mapOpenAIFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'error';
  }
}

function openAIUsage(usage: Record<string, unknown>): Usage {
  const input = readNumber(usage, 'prompt_tokens') ?? 0;
  const output = readNumber(usage, 'completion_tokens') ?? 0;
  const promptDetails = asRecord(usage['prompt_tokens_details']);
  const completionDetails = asRecord(usage['completion_tokens_details']);
  const cacheRead = readNumber(promptDetails, 'cached_tokens') ?? 0;
  const reasoning = readNumber(completionDetails, 'reasoning_tokens') ?? 0;
  return {
    inputTokens: Math.max(0, input - cacheRead),
    outputTokens: output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
