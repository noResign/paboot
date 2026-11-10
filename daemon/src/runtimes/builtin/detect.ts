import { formatModelId, type ProviderModel } from '../../llm/catalog.js';
import { loadProviders, type ResolvedProvider } from '../../llm/credentials.js';
import type { ModelOption, RuntimeCapabilities, RuntimeDetection } from '../types.js';

export const BUILTIN_RUNTIME_ID = 'builtin';
export const BUILTIN_RUNTIME_NAME = 'Builtin';

const BUILTIN_CAPABILITIES: RuntimeCapabilities = {
  partialMessages: true,
  inputStreamJson: false,
  resume: true,
  sessionId: false,
  addDir: false,
  permissionHook: false,
  effort: false,
  mcpConfig: false,
  nativeSystemPrompt: true,
  imageInput: true,
};

/** Qualified model ids exposed to clients, e.g. `anthropic:claude-sonnet-4-6`. */
export function builtinModelOptions(providers: readonly ResolvedProvider[]): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (provider.apiKey === null) continue;
    for (const model of provider.models) {
      if (model.enabled === false) continue;
      options.push(modelOption(provider.id, model));
    }
  }
  return options;
}

function modelOption(providerId: string, model: ProviderModel): ModelOption {
  return {
    id: formatModelId(providerId, model.id),
    label: model.label ?? model.id,
    ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
  };
}

/**
 * The builtin runtime is provider-backed rather than executable-backed. It is
 * available only when at least one configured provider has a credential and at
 * least one enabled model. No key means explicit unavailability, never a
 * silent fallback.
 */
export async function detectBuiltin(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeDetection> {
  try {
    const { providers, warnings } = await loadProviders({ env });
    const authed = providers.some((provider) => provider.apiKey !== null);
    const models = builtinModelOptions(providers);
    const available = models.length > 0;
    let error: string | null = null;
    if (!authed) {
      error = 'no LLM provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY';
    } else if (!available) {
      error = 'configured LLM provider has no enabled models';
    } else if (warnings.length > 0) {
      error = warnings.join('; ');
    }
    return {
      id: BUILTIN_RUNTIME_ID,
      name: BUILTIN_RUNTIME_NAME,
      bin: BUILTIN_RUNTIME_ID,
      available,
      version: null,
      authed,
      capabilities: BUILTIN_CAPABILITIES,
      models,
      error,
    };
  } catch (error) {
    return {
      id: BUILTIN_RUNTIME_ID,
      name: BUILTIN_RUNTIME_NAME,
      bin: BUILTIN_RUNTIME_ID,
      available: false,
      version: null,
      authed: false,
      capabilities: BUILTIN_CAPABILITIES,
      models: [],
      error: `failed to load LLM providers: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function listBuiltinModels(env: NodeJS.ProcessEnv = process.env): Promise<ModelOption[]> {
  return (await detectBuiltin(env)).models;
}
