import { formatModelId, parseModelId, type ProviderModel } from '../llm/catalog.js';
import { LlmError } from '../llm/types.js';
import { loadProviders, type ResolvedProvider } from '../llm/credentials.js';
import { createLlmProvider } from '../llm/providers.js';
import type { LlmProvider } from '../llm/types.js';

/** Main-DB setting; the settings UI wins over the env fallback. */
export const SETTING_MEMORY_MODEL = 'memory_model';

export interface MemoryModelSelection {
  provider: LlmProvider;
  providerId: string;
  model: string;
  modelId: string;
  /** Provider metadata used for diagnostics; never contains the API key. */
  providerConfig: ResolvedProvider;
  modelConfig: ProviderModel;
}

/**
 * Effective memory model: the settings-table choice wins, then the env fallback
 * (`PABOOT_MEMORY_MODEL`) for headless deployments. Empty = record-only.
 */
export function configuredMemoryModel(
  getSetting: (key: string) => string | null,
  fallback: string | null | undefined,
): string | null {
  const stored = getSetting(SETTING_MEMORY_MODEL)?.trim();
  if (stored) return stored;
  const envValue = fallback?.trim();
  return envValue ? envValue : null;
}

/**
 * Resolve the explicitly configured memory model (`PABOOT_MEMORY_MODEL`).
 *
 * Deliberately no "first available provider" fallback: life data must not be
 * sent to a provider the user did not choose for memory. A missing/unusable
 * selection means record-only mode, and pending sources wait for a later
 * configuration (D35).
 */
export async function resolveMemoryModel(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryModelSelection | null> {
  const modelId = requested?.trim();
  if (!modelId) return null;

  const { providers } = await loadProviders({ env });
  const candidates: { provider: ResolvedProvider; model: ProviderModel }[] = [];
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    for (const model of provider.models) {
      if (model.enabled === false) continue;
      candidates.push({ provider, model });
    }
  }

  let selected: { provider: ResolvedProvider; model: ProviderModel } | undefined;
  if (modelId.includes(':')) {
    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelId(modelId);
    } catch (err) {
      if (err instanceof LlmError) return null;
      throw err;
    }
    selected = candidates.find(
      (candidate) =>
        candidate.provider.id === parsed.provider && candidate.model.id === parsed.model,
    );
  } else {
    selected = candidates.find((candidate) => candidate.model.id === modelId);
  }
  if (!selected) return null;

  const provider = createLlmProvider(selected.provider);
  if (!provider) return null;
  return {
    provider,
    providerId: selected.provider.id,
    model: selected.model.id,
    modelId: formatModelId(selected.provider.id, selected.model.id),
    providerConfig: selected.provider,
    modelConfig: selected.model,
  };
}

export interface MemoryModelProvider {
  id: string;
  hasApiKey: boolean;
  models: ReadonlyArray<Pick<ProviderModel, 'id' | 'enabled'>>;
}

/**
 * Validate a `provider:model` selection against the public provider catalog.
 * Returns the canonical id or null. This is deliberately non-throwing so HTTP
 * handlers can turn malformed input into a 400 without leaking an async
 * rejection to Express.
 */
export function normalizeMemoryModelSelection(
  value: string,
  providers: readonly MemoryModelProvider[],
): string | null {
  if (!value.includes(':')) return null;
  let parsed: { provider: string; model: string };
  try {
    parsed = parseModelId(value);
  } catch (err) {
    if (err instanceof LlmError) return null;
    throw err;
  }
  const provider = providers.find((item) => item.id === parsed.provider);
  if (!provider || !provider.hasApiKey) return null;
  const model = provider.models.find((item) => item.id === parsed.model);
  if (!model || model.enabled === false) return null;
  return formatModelId(provider.id, model.id);
}
