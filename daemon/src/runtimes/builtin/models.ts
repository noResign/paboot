import { formatModelId, parseModelId, type ProviderModel } from '../../llm/catalog.js';
import { loadProviders, type ResolvedProvider } from '../../llm/credentials.js';
import { createLlmProvider } from '../../llm/providers.js';
import type { LlmProvider } from '../../llm/types.js';
import type { ModelSnapshot } from './types.js';

export class BuiltinModelError extends Error {
  constructor(
    message: string,
    readonly code: 'no_provider' | 'model_not_found' | 'no_api_key',
  ) {
    super(message);
    this.name = 'BuiltinModelError';
  }
}

export interface ResolvedBuiltinModel {
  modelId: string;
  provider: LlmProvider;
  providerConfig: ResolvedProvider;
  model: string;
  modelConfig: ProviderModel;
  snapshot: ModelSnapshot;
}

/** Resolve the session/request model to a live provider adapter and capabilities. */
export async function resolveBuiltinModel(
  requestedModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedBuiltinModel> {
  const { providers } = await loadProviders({ env });
  const candidates = configuredCandidates(providers);
  if (candidates.length === 0) {
    throw new BuiltinModelError('no configured provider with an API key and model', 'no_provider');
  }

  const selected = selectCandidate(candidates, requestedModel);
  if (!selected) {
    throw new BuiltinModelError(`model is not configured: ${requestedModel ?? '(default)'}`, 'model_not_found');
  }
  if (!selected.provider.apiKey) {
    throw new BuiltinModelError(`provider has no API key: ${selected.provider.id}`, 'no_api_key');
  }
  const adapter = createLlmProvider(selected.provider);
  if (!adapter) {
    throw new BuiltinModelError(`provider cannot be initialized: ${selected.provider.id}`, 'no_api_key');
  }
  return {
    modelId: formatModelId(selected.provider.id, selected.model.id),
    provider: adapter,
    providerConfig: selected.provider,
    model: selected.model.id,
    modelConfig: selected.model,
    snapshot: {
      provider: selected.provider.id,
      model: selected.model.id,
      supportsTools: selected.model.supportsTools ?? true,
      supportsImages: selected.model.supportsImages ?? false,
      ...(selected.model.contextWindow === undefined ? {} : { contextWindow: selected.model.contextWindow }),
      ...(selected.model.maxOutput === undefined ? {} : { maxOutput: selected.model.maxOutput }),
    },
  };
}

interface Candidate {
  provider: ResolvedProvider;
  model: ProviderModel;
}

function configuredCandidates(providers: readonly ResolvedProvider[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    for (const model of provider.models) {
      if (model.enabled === false) continue;
      candidates.push({ provider, model });
    }
  }
  return candidates;
}

function selectCandidate(
  candidates: readonly Candidate[],
  requested: string | undefined,
): Candidate | null {
  if (!requested) return candidates[0] ?? null;
  if (requested.includes(':')) {
    const parsed = parseModelId(requested);
    return candidates.find(
      (candidate) => candidate.provider.id === parsed.provider && candidate.model.id === parsed.model,
    ) ?? null;
  }
  return candidates.find((candidate) => candidate.model.id === requested) ?? null;
}
