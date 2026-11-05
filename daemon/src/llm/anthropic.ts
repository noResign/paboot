import { aggregateCompletion } from './complete.js';
import {
  errorFromResponse,
  LlmRequestError,
  normalizeRequestError,
  type StreamRetryOptions,
  withStreamRetry,
} from './errors.js';
import { readSse, requestSse, type FetchLike, type SseEvent } from './sse.js';
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

export interface AnthropicProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  retry?: Omit<StreamRetryOptions, 'signal'>;
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4_096;

export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic' as const;
  readonly available: boolean;
  readonly unavailableReason: string | undefined;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.available = options.apiKey.trim().length > 0;
    this.unavailableReason = this.available ? undefined : 'Anthropic API key is missing';
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
    const response = await requestSse(
      `${trimTrailingSlash(this.options.baseUrl)}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildAnthropicBody(request)),
      },
      {
        signal: request.signal,
        connectTimeoutMs: this.options.connectTimeoutMs,
        idleTimeoutMs: this.options.idleTimeoutMs,
        fetch: this.options.fetch,
      },
    );
    if (!response.ok) {
      throw errorFromResponse(response, await response.text().catch(() => ''));
    }

    let stopReason: string | null = null;
    let sawFinish = false;
    let sawUsage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    for await (const event of readSse(response, {
      signal: request.signal,
      idleTimeoutMs: this.options.idleTimeoutMs,
    })) {
      const payload = parseAnthropicEvent(event);
      if (!payload) continue;
      const type = typeof payload['type'] === 'string' ? payload['type'] : event.event;

      switch (type) {
        case 'message_start': {
          const usage = asRecord(asRecord(payload['message'])?.['usage']);
          if (usage) {
            inputTokens = readNumber(usage, 'input_tokens') ?? inputTokens;
            outputTokens = readNumber(usage, 'output_tokens') ?? outputTokens;
            cacheReadTokens =
              readNumber(usage, 'cache_read_input_tokens') ?? cacheReadTokens;
            cacheWriteTokens =
              readNumber(usage, 'cache_creation_input_tokens') ?? cacheWriteTokens;
            sawUsage = true;
          }
          break;
        }
        case 'content_block_start': {
          const index = readNumber(payload, 'index') ?? 0;
          const block = asRecord(payload['content_block']);
          if (readString(block, 'type') === 'tool_use') {
            yield {
              type: 'tool_call_start',
              index,
              id: readString(block, 'id') ?? `tool_${index}`,
              name: readString(block, 'name') ?? 'unknown_tool',
            };
          }
          break;
        }
        case 'content_block_delta': {
          const index = readNumber(payload, 'index') ?? 0;
          const delta = asRecord(payload['delta']);
          const deltaType = readString(delta, 'type');
          if (deltaType === 'text_delta') {
            const text = readString(delta, 'text');
            if (text) yield { type: 'text_delta', text };
          } else if (deltaType === 'thinking_delta') {
            const text = readString(delta, 'thinking');
            if (text) yield { type: 'reasoning_delta', text };
          } else if (deltaType === 'input_json_delta') {
            const argsDelta = readString(delta, 'partial_json');
            if (argsDelta !== null) yield { type: 'tool_call_delta', index, argsDelta };
          }
          break;
        }
        case 'message_delta': {
          const delta = asRecord(payload['delta']);
          const nextStop = readString(delta, 'stop_reason');
          if (nextStop) stopReason = nextStop;
          const usage = asRecord(payload['usage']);
          if (usage) {
            outputTokens = readNumber(usage, 'output_tokens') ?? outputTokens;
            inputTokens = readNumber(usage, 'input_tokens') ?? inputTokens;
            cacheReadTokens =
              readNumber(usage, 'cache_read_input_tokens') ?? cacheReadTokens;
            cacheWriteTokens =
              readNumber(usage, 'cache_creation_input_tokens') ?? cacheWriteTokens;
            sawUsage = true;
          }
          break;
        }
        case 'message_stop': {
          if (sawUsage) {
            yield {
              type: 'usage',
              usage: usageSnapshot(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
              contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
            };
          }
          yield { type: 'finish', reason: mapAnthropicStopReason(stopReason), ...(stopReason ? { rawReason: stopReason } : {}) };
          sawFinish = true;
          break;
        }
        case 'error': {
          const error = asRecord(payload['error']);
          const detail = readString(error, 'message') ?? 'Anthropic stream error';
          const errorType = readString(error, 'type') ?? 'provider_error';
          const retryable = errorType === 'overloaded_error' || errorType === 'rate_limit_error';
          throw new LlmRequestError('provider', detail, { retryable });
        }
        case 'ping':
        default:
          break;
      }
      if (sawFinish) break;
    }

    if (!sawFinish) {
      throw new LlmRequestError('stream_incomplete', 'Anthropic stream ended without message_stop', {
        retryable: true,
      });
    }
  }
}

export function buildAnthropicBody(request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: request.messages.map(renderAnthropicMessage),
    stream: true,
  };
  if (request.system.trim()) body['system'] = request.system;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
  return body;
}

function renderAnthropicMessage(message: LlmMessage): Record<string, unknown> {
  return {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(renderAnthropicBlock),
  };
}

function renderAnthropicBlock(block: LlmContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}

function parseAnthropicEvent(event: SseEvent): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(event.data) as unknown;
    return asRecord(parsed);
  } catch (error) {
    throw new LlmRequestError('protocol', 'invalid Anthropic SSE JSON', {
      cause: error,
    });
  }
}

function mapAnthropicStopReason(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    case null:
      return 'stop';
    default:
      return 'error';
  }
}

function usageSnapshot(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): Usage {
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
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
