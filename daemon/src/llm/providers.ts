import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
import { OpenAIProvider, type OpenAIProviderOptions } from './openai.js';
import { LlmRegistry } from './registry.js';
import type { LlmProvider } from './types.js';
import type { ResolvedProvider } from './credentials.js';
import type { FetchLike } from './sse.js';

export interface ProviderFactoryOptions {
  fetch?: FetchLike;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  includeStreamUsage?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}

/** Build a live adapter from a secret-bearing resolved provider record. */
export function createLlmProvider(
  provider: ResolvedProvider,
  options: ProviderFactoryOptions = {},
): LlmProvider | null {
  if (!provider.apiKey) return null;
  if (provider.kind === 'anthropic') {
    const config: AnthropicProviderOptions = {
      id: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      fetch: options.fetch,
      connectTimeoutMs: options.connectTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    };
    return new AnthropicProvider(config);
  }
  const config: OpenAIProviderOptions = {
    id: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fetch: options.fetch,
    connectTimeoutMs: options.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    includeStreamUsage: options.includeStreamUsage,
    maxTokensField: options.maxTokensField,
  };
  return new OpenAIProvider(config);
}

export function createLlmProviders(
  providers: readonly ResolvedProvider[],
  options: ProviderFactoryOptions = {},
): LlmProvider[] {
  return providers
    .map((provider) => createLlmProvider(provider, options))
    .filter((provider): provider is LlmProvider => provider !== null);
}

/** Build the shared registry used by builtin runtime and background jobs. */
export function createLlmRegistryFromProviders(
  providers: readonly ResolvedProvider[],
  options: ProviderFactoryOptions = {},
): LlmRegistry {
  return new LlmRegistry(createLlmProviders(providers, options));
}
