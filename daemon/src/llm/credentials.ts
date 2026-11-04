import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BUILTIN_PROVIDERS,
  mergeProviderInputs,
  parseProviderInput,
  type ProviderConfig,
  type ProviderInput,
} from './catalog.js';
import { LlmError, type ProviderKind } from './types.js';

export type ApiKeySource = 'file' | 'env';

/** Internal provider record: `apiKey` must never be returned by an API route. */
export interface ResolvedProvider extends ProviderConfig {
  apiKey: string | null;
  apiKeySource: ApiKeySource | null;
}

/** The only shape routes may serialize; deliberately has no `apiKey` field. */
export interface PublicProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  models: ProviderConfig['models'];
  hasApiKey: boolean;
  apiKeySource: ApiKeySource | null;
}

/** A provider entry as written in `providers.json` / `PABOOT_LLM_PROVIDERS`. */
export interface ProviderFileEntry extends ProviderInput {
  /** Plaintext secret in the file only; never exposed by the public view. */
  apiKey?: string | null;
}

export interface LoadProvidersOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to `PABOOT_LLM_PROVIDERS_FILE` or `~/.paboot/providers.json`. */
  providersFile?: string;
}

export interface LoadProvidersResult {
  providers: ResolvedProvider[];
  /** Validation/read problems; never contains secrets. */
  warnings: string[];
  providersFile: string;
}

export const DEFAULT_PROVIDERS_FILE = (): string =>
  path.join(os.homedir(), '.paboot', 'providers.json');

/**
 * Load the provider catalog from the three sources, in order:
 * built-in templates → `PABOOT_LLM_PROVIDERS` inline JSON → providers.json.
 * Later sources override fields by provider id; `models` arrays replace.
 *
 * Key resolution: a providers.json / inline `apiKey` wins, then the provider's
 * `apiKeyEnv` environment variable, else none. The plaintext key stays on the
 * internal record only; use {@link toPublicProvider} for anything client-facing.
 */
export async function loadProviders(options: LoadProvidersOptions = {}): Promise<LoadProvidersResult> {
  const env = options.env ?? process.env;
  const providersFile = options.providersFile ??
    (env.PABOOT_LLM_PROVIDERS_FILE?.trim() || DEFAULT_PROVIDERS_FILE());
  const warnings: string[] = [];
  const entries: ProviderFileEntry[] = [];

  const inline = env.PABOOT_LLM_PROVIDERS?.trim();
  if (inline) {
    const parsed = parseDocument(inline, 'PABOOT_LLM_PROVIDERS');
    warnings.push(...parsed.warnings);
    entries.push(...parsed.entries);
  }

  const fileText = await readIfExists(providersFile);
  if (fileText.error) {
    warnings.push(fileText.error);
  } else if (fileText.text !== null) {
    const parsed = parseDocument(fileText.text, 'providers.json');
    warnings.push(...parsed.warnings);
    entries.push(...parsed.entries);
  }

  const lastKeyByProvider = new Map<string, string | null>();
  const validEntries: ProviderInput[] = [];
  const knownIds = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id));
  for (const entry of entries) {
    if (entry.apiKey !== undefined) {
      lastKeyByProvider.set(entry.id, entry.apiKey);
    }
    if (!knownIds.has(entry.id)) {
      if (entry.kind === undefined || entry.baseUrl === undefined) {
        warnings.push(`provider "${entry.id}" needs kind and baseUrl the first time it is defined`);
        continue;
      }
      knownIds.add(entry.id);
    }
    const { apiKey: _apiKey, ...input } = entry;
    validEntries.push(input);
  }

  const merged = mergeProviderInputs(BUILTIN_PROVIDERS, validEntries);
  const providers = merged.map((provider): ResolvedProvider => {
    const fileKey = lastKeyByProvider.get(provider.id);
    if (typeof fileKey === 'string' && fileKey.trim() !== '') {
      return { ...provider, apiKey: fileKey.trim(), apiKeySource: 'file' };
    }
    const envKey = provider.apiKeyEnv ? env[provider.apiKeyEnv]?.trim() : undefined;
    if (envKey) {
      return { ...provider, apiKey: envKey, apiKeySource: 'env' };
    }
    return { ...provider, apiKey: null, apiKeySource: null };
  });

  return { providers, warnings, providersFile };
}

export function toPublicProvider(provider: ResolvedProvider): PublicProvider {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({ ...model })),
    hasApiKey: provider.apiKey !== null,
    apiKeySource: provider.apiKeySource,
  };
}

export function toPublicProviders(providers: readonly ResolvedProvider[]): PublicProvider[] {
  return providers.map(toPublicProvider);
}

/**
 * Write `providers.json` atomically with 0600 permissions. The file is the
 * write-only side of the credential store: reads go through {@link loadProviders},
 * and no API response may include the plaintext keys written here.
 */
export async function writeProvidersFile(
  filePath: string,
  entries: readonly ProviderFileEntry[],
): Promise<void> {
  const normalized: ProviderFileEntry[] = entries.map((entry) => {
    const input = parseProviderInput(entry);
    if (entry.apiKey === undefined) return input;
    if (entry.apiKey !== null && typeof entry.apiKey !== 'string') {
      throw new LlmError('invalid_provider', `apiKey for "${entry.id}" must be a string or null`);
    }
    return { ...input, apiKey: entry.apiKey === null ? null : entry.apiKey.trim() || null };
  });

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const data = `${JSON.stringify({ version: 1, providers: normalized }, null, 2)}\n`;
  try {
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readIfExists(filePath: string): Promise<{ text: string | null; error: string | null }> {
  try {
    return { text: await fs.readFile(filePath, 'utf8'), error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, error: null };
    return { text: null, error: `could not read ${path.basename(filePath)}` };
  }
}

function parseDocument(
  text: string,
  label: string,
): { entries: ProviderFileEntry[]; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], warnings: [`${label} is not valid JSON`] };
  }

  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.providers)
      ? raw.providers
      : null;
  if (!list) {
    return { entries: [], warnings: [`${label} must be an array or { providers: [] }`] };
  }

  const entries: ProviderFileEntry[] = [];
  const warnings: string[] = [];
  for (const [index, item] of list.entries()) {
    try {
      if (!isRecord(item)) {
        throw new LlmError('invalid_provider', 'entry must be an object');
      }
      const input = parseProviderInput(item);
      const entry: ProviderFileEntry = { ...input };
      if (item.apiKey !== undefined) {
        if (item.apiKey !== null && typeof item.apiKey !== 'string') {
          throw new LlmError('invalid_provider', `apiKey for "${input.id}" must be a string or null`);
        }
        entry.apiKey = item.apiKey === null ? null : item.apiKey.trim() || null;
      }
      entries.push(entry);
    } catch (error) {
      const message = error instanceof LlmError ? error.message : 'invalid entry';
      warnings.push(`${label} entry #${index + 1}: ${message}`);
    }
  }
  return { entries, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
