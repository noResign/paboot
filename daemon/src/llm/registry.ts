import { NONE_PROVIDER_ID, PROVIDER_ID_PATTERN, parseModelId } from './catalog.js';
import {
  LlmError,
  type LlmChunk,
  type LlmCompletion,
  type LlmProvider,
  type LlmRequest,
} from './types.js';

/**
 * Explicit degradation. `available=false` is how Memory knows to keep
 * recording without extracting, and how the builtin runtime reports
 * "no provider configured". Calls never throw: they return an explicit
 * `unavailable` finish so a caller that ignored `available` still fails safe.
 */
export const noneProvider: LlmProvider = {
  id: NONE_PROVIDER_ID,
  kind: 'none',
  available: false,
  unavailableReason: 'no llm provider configured',
  async *stream(_request: LlmRequest): AsyncIterable<LlmChunk> {
    yield { type: 'finish', reason: 'unavailable' };
  },
  async complete(_request: LlmRequest): Promise<LlmCompletion> {
    return { text: '', toolCalls: [], finishReason: 'unavailable', usage: null };
  },
};

/**
 * Holds the provider instances. P0.4 only wires `none`; P3.1 registers real
 * adapters here. The registry never reads credentials itself — adapters are
 * built from the catalog and `ResolvedProvider` records by their owner.
 */
export class LlmRegistry {
  private readonly providers = new Map<string, LlmProvider>();

  constructor(providers: readonly LlmProvider[] = []) {
    this.register(noneProvider);
    for (const provider of providers) this.register(provider);
  }

  register(provider: LlmProvider): void {
    if (!PROVIDER_ID_PATTERN.test(provider.id)) {
      throw new LlmError('invalid_provider', `invalid provider id "${provider.id}"`);
    }
    if (this.providers.has(provider.id)) {
      throw new LlmError('duplicate_provider', `provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): LlmProvider | undefined {
    return this.providers.get(id);
  }

  require(id: string): LlmProvider {
    const provider = this.get(id);
    if (!provider) throw new LlmError('unknown_provider', `unknown provider "${id}"`);
    return provider;
  }

  /** Deterministic (id-sorted) list, including `none`. */
  list(): LlmProvider[] {
    return [...this.providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * True when at least one real provider can serve requests. `none` is always
   * registered, so this is the Memory "record only" signal.
   */
  hasAvailableProvider(): boolean {
    return this.list().some((provider) => provider.available);
  }

  /** Split a `<provider>:<model>` id and require the provider to exist. */
  resolveModel(modelId: string): { provider: LlmProvider; model: string } {
    const { provider, model } = parseModelId(modelId);
    return { provider: this.require(provider), model };
  }
}

export function createLlmRegistry(providers: readonly LlmProvider[] = []): LlmRegistry {
  return new LlmRegistry(providers);
}
