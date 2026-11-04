import { LlmError, type ProviderKind } from './types.js';

/** Provider ids are stable, lowercase and used in `<provider>:<model>` ids. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

export const NONE_PROVIDER_ID = 'none';

export type RealProviderKind = Exclude<ProviderKind, 'none'>;

export interface ProviderModel {
  /** Bare model id; the qualified id is `<provider>:<id>`. */
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** Whether the model accepts tool schemas / tool calls. */
  supportsTools?: boolean;
  /** Whether the model accepts image blocks (builtin runtime + vision models only). */
  supportsImages?: boolean;
  enabled?: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: RealProviderKind;
  label: string;
  /** API root, without the `/v1/...` path (the adapter appends it). */
  baseUrl: string;
  /** Env var that supplies the key when providers.json does not have one. */
  apiKeyEnv: string | null;
  models: ProviderModel[];
}

/** A partial source entry (env JSON / providers.json); later sources override by id. */
export interface ProviderInput {
  id: string;
  kind?: RealProviderKind;
  label?: string;
  baseUrl?: string;
  apiKeyEnv?: string | null;
  models?: ProviderModel[];
}

/**
 * Built-in provider templates. Models are intentionally empty: the catalog
 * (P2 refresh / P3 adapters) fills them, so no stale model names get baked in.
 */
export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [],
  },
  {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [],
  },
  {
    id: 'deepseek',
    kind: 'openai',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [],
  },
];

/** `<provider>:<model>`; split at the first colon so model ids may contain colons. */
export function parseModelId(value: string): { provider: string; model: string } {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new LlmError('invalid_model', 'model id must be "<provider>:<model>"');
  }
  const provider = trimmed.slice(0, colon);
  const model = trimmed.slice(colon + 1);
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    throw new LlmError('invalid_model', `invalid provider id "${provider}"`);
  }
  if (model.trim() === '' || /\s/.test(model)) {
    throw new LlmError('invalid_model', 'model name must be non-empty and contain no whitespace');
  }
  return { provider, model };
}

export function formatModelId(provider: string, model: string): string {
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    throw new LlmError('invalid_model', `invalid provider id "${provider}"`);
  }
  if (model.trim() === '' || /\s/.test(model)) {
    throw new LlmError('invalid_model', 'model name must be non-empty and contain no whitespace');
  }
  return `${provider}:${model}`;
}

/** Validate one source entry; does not merge with templates. */
export function parseProviderInput(raw: unknown): ProviderInput {
  if (!isRecord(raw)) {
    throw new LlmError('invalid_provider', 'provider entry must be an object');
  }
  const id = requireString(raw, 'id').trim();
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new LlmError('invalid_provider', `invalid provider id "${id}"`);
  }
  if (id === NONE_PROVIDER_ID) {
    throw new LlmError('invalid_provider', `"${NONE_PROVIDER_ID}" is reserved`);
  }

  const input: ProviderInput = { id };
  if (raw.kind !== undefined) {
    if (raw.kind !== 'anthropic' && raw.kind !== 'openai') {
      throw new LlmError('invalid_provider', `invalid kind for "${id}"`);
    }
    input.kind = raw.kind;
  }
  if (raw.label !== undefined) input.label = requireString(raw, 'label');
  if (raw.baseUrl !== undefined) input.baseUrl = parseBaseUrl(requireString(raw, 'baseUrl'), id);
  if (raw.apiKeyEnv !== undefined) {
    if (raw.apiKeyEnv === null) input.apiKeyEnv = null;
    else input.apiKeyEnv = requireString(raw, 'apiKeyEnv');
  }
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) {
      throw new LlmError('invalid_provider', `models for "${id}" must be an array`);
    }
    input.models = raw.models.map((model) => parseModel(model, id));
    const seen = new Set<string>();
    for (const model of input.models) {
      if (seen.has(model.id)) {
        throw new LlmError('invalid_provider', `duplicate model "${model.id}" in "${id}"`);
      }
      seen.add(model.id);
    }
  }
  return input;
}

/**
 * Merge source entries over the built-in templates, in order. A later entry
 * overrides the same id field-by-field; `models` replaces the whole array
 * (never per-model merge, so deleted models do not come back as ghosts).
 * New ids need `kind` and `baseUrl`.
 */
export function mergeProviderInputs(
  templates: readonly ProviderConfig[],
  inputs: readonly ProviderInput[],
): ProviderConfig[] {
  const merged = templates.map((template) => ({ ...template, models: [...template.models] }));
  const byId = new Map(merged.map((provider) => [provider.id, provider]));

  for (const input of inputs) {
    const existing = byId.get(input.id);
    if (existing) {
      if (input.kind !== undefined) existing.kind = input.kind;
      if (input.label !== undefined) existing.label = input.label;
      if (input.baseUrl !== undefined) existing.baseUrl = input.baseUrl;
      if (input.apiKeyEnv !== undefined) existing.apiKeyEnv = input.apiKeyEnv;
      if (input.models !== undefined) existing.models = input.models;
      continue;
    }
    if (input.kind === undefined || input.baseUrl === undefined) {
      throw new LlmError(
        'invalid_provider',
        `provider "${input.id}" needs kind and baseUrl the first time it is defined`,
      );
    }
    const created: ProviderConfig = {
      id: input.id,
      kind: input.kind,
      label: input.label ?? input.id,
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv ?? null,
      models: input.models ?? [],
    };
    byId.set(created.id, created);
    merged.push(created);
  }

  return merged;
}

function parseModel(raw: unknown, providerId: string): ProviderModel {
  if (!isRecord(raw)) {
    throw new LlmError('invalid_provider', `model entry for "${providerId}" must be an object`);
  }
  const id = requireString(raw, 'id').trim();
  if (id === '' || id.includes(':') || /\s/.test(id)) {
    throw new LlmError('invalid_provider', `invalid model id "${id}" in "${providerId}"`);
  }
  const model: ProviderModel = { id };
  if (raw.label !== undefined) model.label = requireString(raw, 'label');
  if (raw.contextWindow !== undefined) model.contextWindow = positiveInt(raw.contextWindow, 'contextWindow');
  if (raw.maxOutput !== undefined) model.maxOutput = positiveInt(raw.maxOutput, 'maxOutput');
  if (raw.supportsTools !== undefined) {
    if (typeof raw.supportsTools !== 'boolean') {
      throw new LlmError('invalid_provider', `supportsTools for "${providerId}/${id}" must be boolean`);
    }
    model.supportsTools = raw.supportsTools;
  }
  if (raw.supportsImages !== undefined) {
    if (typeof raw.supportsImages !== 'boolean') {
      throw new LlmError('invalid_provider', `supportsImages for "${providerId}/${id}" must be boolean`);
    }
    model.supportsImages = raw.supportsImages;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw new LlmError('invalid_provider', `enabled for "${providerId}/${id}" must be boolean`);
    }
    model.enabled = raw.enabled;
  }
  return model;
}

function parseBaseUrl(value: string, providerId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmError('invalid_provider', `invalid baseUrl for "${providerId}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmError('invalid_provider', `baseUrl for "${providerId}" must be http(s)`);
  }
  // Keep the operator's path as-is; strip only a trailing slash so adapters can
  // append `/v1/...` deterministically.
  return value.replace(/\/+$/, '');
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LlmError('invalid_provider', `"${key}" must be a non-empty string`);
  }
  return value;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new LlmError('invalid_provider', `"${field}" must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
