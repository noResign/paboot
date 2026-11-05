import { BUILTIN_PROVIDERS, parseProviderInput, type ProviderModel } from '../llm/catalog.js';
import {
  loadProviders,
  readProvidersFileEntries,
  toPublicProvider,
  writeProvidersFile,
  type ProviderFileEntry,
  type PublicProvider,
  type ResolvedProvider,
} from '../llm/credentials.js';
import type { FetchLike } from '../llm/sse.js';
import { sanitizeErrorMessage } from '../llm/errors.js';
import type { RealProviderKind } from '../llm/catalog.js';

export class ProviderManagerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProviderManagerError';
  }
}

export interface ProviderCreateInput {
  id: string;
  kind: RealProviderKind;
  label?: string;
  baseUrl: string;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  models?: ProviderModel[];
}

export interface ProviderUpdateInput {
  kind?: RealProviderKind;
  label?: string;
  baseUrl?: string;
  /** Omit = unchanged, null/empty = clear file key, string = replace. */
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  models?: ProviderModel[];
}

export interface ProviderTestResult {
  ok: true;
  status: number;
  latencyMs: number;
  modelCount: number | null;
}

export interface ProviderManagerOptions {
  env?: NodeJS.ProcessEnv;
  providersFile: string;
  /** Test seam for /models connectivity checks. */
  fetch?: FetchLike;
  testTimeoutMs?: number;
}

/**
 * Owns the provider config file and the public provider API. Keys remain inside
 * this service; responses use PublicProvider and never include plaintext keys.
 */
export class ProviderManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;
  private readonly testTimeoutMs: number;

  constructor(private readonly options: ProviderManagerOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.testTimeoutMs = options.testTimeoutMs ?? 5_000;
  }

  async list(): Promise<PublicProvider[]> {
    const { providers } = await loadProviders({
      env: this.env,
      providersFile: this.options.providersFile,
    });
    return providers.map(toPublicProvider);
  }

  async get(id: string): Promise<PublicProvider | undefined> {
    return (await this.list()).find((provider) => provider.id === id);
  }

  async create(input: ProviderCreateInput): Promise<PublicProvider> {
    const existing = await this.resolvedProviders();
    if (existing.some((provider) => provider.id === input.id)) {
      throw new ProviderManagerError(`provider already exists: ${input.id}`, 'provider_exists', 409);
    }
    const entry = parseProviderInput({
      id: input.id,
      kind: input.kind,
      label: input.label,
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv,
      models: input.models ?? [],
    }) as ProviderFileEntry;
    if (input.apiKey !== undefined) {
      entry.apiKey = normalizeApiKey(input.apiKey);
    }
    const file = await readProvidersFileEntries(this.options.providersFile);
    await writeProvidersFile(this.options.providersFile, [...file.entries, entry]);
    return this.requirePublic(input.id);
  }

  async update(id: string, input: ProviderUpdateInput): Promise<PublicProvider> {
    const current = await this.requireResolved(id);
    const file = await readProvidersFileEntries(this.options.providersFile);
    const currentFile = file.entries.find((entry) => entry.id === id);
    const entry: ProviderFileEntry = {
      id,
      kind: input.kind ?? current.kind,
      label: input.label ?? current.label,
      baseUrl: input.baseUrl ?? current.baseUrl,
      apiKeyEnv: input.apiKeyEnv !== undefined ? input.apiKeyEnv : current.apiKeyEnv,
      models: input.models ?? current.models,
    };
    if (input.apiKey !== undefined) {
      entry.apiKey = normalizeApiKey(input.apiKey);
    } else if (currentFile && 'apiKey' in currentFile) {
      entry.apiKey = currentFile.apiKey ?? null;
    }
    parseProviderInput(entry);
    const entries = file.entries.filter((item) => item.id !== id);
    entries.push(entry);
    await writeProvidersFile(this.options.providersFile, entries);
    return this.requirePublic(id);
  }

  async delete(id: string): Promise<void> {
    if (BUILTIN_PROVIDERS.some((provider) => provider.id === id)) {
      throw new ProviderManagerError(
        'built-in providers cannot be deleted; clear the key/models instead',
        'provider_is_builtin',
        409,
      );
    }
    const file = await readProvidersFileEntries(this.options.providersFile);
    const entries = file.entries.filter((entry) => entry.id !== id);
    if (entries.length === file.entries.length) {
      throw new ProviderManagerError(`provider not found in providers.json: ${id}`, 'provider_not_found', 404);
    }
    await writeProvidersFile(this.options.providersFile, entries);
  }

  async test(id: string): Promise<ProviderTestResult> {
    const provider = await this.requireResolved(id);
    const started = Date.now();
    const result = await this.fetchModels(provider);
    return {
      ok: true,
      status: result.status,
      latencyMs: Date.now() - started,
      modelCount: result.modelCount,
    };
  }

  async refreshModels(id: string): Promise<PublicProvider> {
    const provider = await this.requireResolved(id);
    const result = await this.fetchModels(provider);
    if (result.ids.length === 0) {
      throw new ProviderManagerError('provider returned no models', 'provider_models_empty', 502);
    }
    const byId = new Map(provider.models.map((model) => [model.id, { ...model }]));
    for (const modelId of result.ids) {
      if (!byId.has(modelId)) {
        byId.set(modelId, {
          id: modelId,
          label: modelId,
          supportsTools: true,
          supportsImages: false,
          enabled: true,
        });
      }
    }
    return this.update(id, { models: [...byId.values()] });
  }

  private async resolvedProviders(): Promise<ResolvedProvider[]> {
    return (await loadProviders({
      env: this.env,
      providersFile: this.options.providersFile,
    })).providers;
  }

  private async requireResolved(id: string): Promise<ResolvedProvider> {
    const provider = (await this.resolvedProviders()).find((item) => item.id === id);
    if (!provider) throw new ProviderManagerError(`provider not found: ${id}`, 'provider_not_found', 404);
    return provider;
  }

  private async requirePublic(id: string): Promise<PublicProvider> {
    const provider = await this.get(id);
    if (!provider) throw new ProviderManagerError(`provider not found: ${id}`, 'provider_not_found', 404);
    return provider;
  }

  private async fetchModels(provider: ResolvedProvider): Promise<{
    status: number;
    modelCount: number | null;
    ids: string[];
  }> {
    if (!provider.apiKey) {
      throw new ProviderManagerError(`provider has no API key: ${provider.id}`, 'provider_api_key_missing', 400);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.testTimeoutMs);
    try {
      const url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/models`;
      const headers: Record<string, string> =
        provider.kind === 'anthropic'
          ? {
              'x-api-key': provider.apiKey,
              'anthropic-version': '2023-06-01',
              accept: 'application/json',
            }
          : { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' };
      const response = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new ProviderManagerError(
          `provider models request failed (${response.status}): ${sanitizeErrorMessage(text)}`,
          'provider_test_failed',
          502,
        );
      }
      const parsed = parseJson(text);
      const data = parsed && Array.isArray(parsed['data']) ? parsed['data'] : [];
      const ids = data
        .map((item) => (isRecord(item) && typeof item['id'] === 'string' ? item['id'] : null))
        .filter((id): id is string => Boolean(id));
      return { status: response.status, modelCount: ids.length, ids };
    } catch (error) {
      if (error instanceof ProviderManagerError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new ProviderManagerError('provider test timed out', 'provider_test_timeout', 504);
      }
      throw new ProviderManagerError(
        `provider test failed: ${error instanceof Error ? error.message : String(error)}`,
        'provider_test_failed',
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeApiKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
