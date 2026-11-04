/**
 * Shared LLM layer contract (P0.4).
 *
 * Concrete adapters (Anthropic Messages / OpenAI-compatible) live in P3.1;
 * this file is the only shape the builtin runtime, Memory and background jobs
 * share. Providers translate the neutral request into their wire format and
 * translate their SSE back into {@link LlmChunk}.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'none';

/**
 * `unavailable` is only emitted by the explicit `none` provider: the LLM layer
 * never silently substitutes a real provider when none is configured.
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_use'
  | 'content_filter'
  | 'error'
  | 'cancelled'
  | 'unavailable';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache read tokens, when the provider reports them. */
  cacheReadTokens?: number;
  /** Prompt-cache write tokens, when the provider reports them. */
  cacheWriteTokens?: number;
  /** Filled only when the adapter has a price table; null otherwise. */
  costUsd?: number | null;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool input; adapters wrap it per provider. */
  inputSchema: Record<string, unknown>;
}

/** Image formats the shared request accepts; attachments convert to one of these. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * Neutral conversation content; adapters render it into their own format.
 *
 * The image block carries raw base64 **without** a `data:` URL prefix. Images
 * only become base64 at the model-request boundary; the builtin transcript and
 * events keep attachment references, not the bytes (see builtin P5.1 design).
 */
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContentBlock[];
}

export interface LlmRequest {
  provider: string;
  /** Bare model name (no `<provider>:` prefix); use catalog.parseModelId to split. */
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export type LlmChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string }
  | { type: 'usage'; usage: Usage; contextTokens: number }
  | { type: 'finish'; reason: FinishReason; rawReason?: string };

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string as streamed; the caller parses and validates it. */
  arguments: string;
}

export interface LlmCompletion {
  text: string;
  /** Reasoning text, when the provider returns it; adapters may omit it. */
  reasoning?: string;
  toolCalls: LlmToolCall[];
  finishReason: FinishReason;
  rawFinishReason?: string;
  usage: Usage | null;
}

export interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** False for `none` and for a configured provider that is not usable yet. */
  readonly available: boolean;
  /** Short, secret-free reason shown in diagnostics when unavailable. */
  readonly unavailableReason?: string;
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

export type LlmErrorCode =
  | 'unknown_provider'
  | 'invalid_provider'
  | 'invalid_model'
  | 'provider_unavailable'
  | 'duplicate_provider';

export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}
