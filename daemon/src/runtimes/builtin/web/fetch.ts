import { extractProviderMessage, sanitizeErrorMessage } from '../../../llm/errors.js';
import type { BuiltinRuntimeConfig } from '../config.js';
import { createHttpFetchBackend } from './fetch-http.js';

export interface FetchedPage {
  content: string;
}

/** One page-fetch backend. The tool only sees this interface. */
export interface FetchBackend {
  readonly id: 'provider' | 'http';
  fetch(url: string, signal: AbortSignal): Promise<FetchedPage>;
}

export interface FetchBackendSelection {
  backend: FetchBackend | null;
  /** Why nothing is usable; surfaced by the tool when config asked for it. */
  unavailableReason: string | null;
  /**
   * Set when `auto` could not use the provider backend and fell back to the
   * local one. The local backend can reach intranet and loopback addresses, so
   * the switch widens what the agent can touch and must be visible in the log.
   */
  fallbackFrom?: 'provider' | null;
}

export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchError';
  }
}

export interface ProviderEndpoint {
  kind: string;
  baseUrl: string;
  apiKey: string | null;
}

/**
 * The web API base that serves Fetch, derived from the model provider's
 * completions base. The endpoints live under `<origin>/v1/tools`, not under the
 * completions base itself — posting to `<base>/fetch` returns 404.
 *
 * Every provider is assumed to expose this layout; a gateway with a different
 * one sets `web.fetch.baseUrl` to bypass the derivation.
 */
export function providerFetchBaseUrl(providerBaseUrl: string): string | null {
  try {
    return `${new URL(providerBaseUrl).origin}/v1/tools`;
  } catch {
    return null;
  }
}

/**
 * Provider-hosted fetch: `POST <webApiBase>/fetch` returns Markdown. It runs on
 * the provider's servers, so it cannot reach intranet or loopback addresses.
 */
export function createProviderFetchBackend(input: {
  /** The web API base (already `/v1/tools`), not the completions base. */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}): FetchBackend {
  const endpoint = `${input.baseUrl.replace(/\/+$/, '')}/fetch`;
  return {
    id: 'provider',
    async fetch(url, signal) {
      const timeout = AbortSignal.timeout(input.timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({ url }),
          signal: combined,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new WebFetchError(
          timeout.aborted
            ? `web fetch timed out after ${input.timeoutMs}ms`
            : `web fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new WebFetchError(
          `web fetch failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new WebFetchError('web fetch returned a non-JSON response');
      }
      if (!isRecord(payload) || typeof payload['content'] !== 'string') {
        throw new WebFetchError('web fetch returned an invalid response body');
      }
      return { content: payload['content'] };
    },
  };
}

/**
 * Resolve the fetch backend from config.
 *
 * - `provider`: provider-hosted only. Unusable config reports why instead of
 *   switching backends — a silent switch would change network exposure.
 * - `http`: local only (can reach intranet and loopback; text bodies only).
 * - `auto`: provider-hosted when the selected model provider has an API key,
 *   otherwise the local backend. The fallback is reported through
 *   {@link FetchBackendSelection.fallbackFrom} so the driver can log the
 *   widened reach instead of it happening invisibly.
 *
 * The provider endpoint is the web API base (`<origin>/v1/tools`) derived from
 * the selected provider's completions base. An explicit `baseUrl` is taken
 * verbatim for the provider backend.
 */
export function resolveFetchBackend(input: {
  settings: BuiltinRuntimeConfig['web']['fetch'];
  provider: ProviderEndpoint;
}): FetchBackendSelection {
  const { settings, provider } = input;
  if (!settings.enabled) return { backend: null, unavailableReason: null };

  if (settings.provider === 'http') {
    return {
      backend: createHttpFetchBackend({ timeoutMs: settings.timeoutMs }),
      unavailableReason: null,
      fallbackFrom: null,
    };
  }

  const apiKey = provider.apiKey;
  const webApiBase = settings.baseUrl ?? providerFetchBaseUrl(provider.baseUrl);
  const usable = apiKey !== null && apiKey.length > 0 && webApiBase !== null;

  if (usable) {
    return {
      backend: createProviderFetchBackend({
        baseUrl: webApiBase,
        apiKey: apiKey!,
        timeoutMs: settings.timeoutMs,
      }),
      unavailableReason: null,
      fallbackFrom: null,
    };
  }

  if (settings.provider === 'auto') {
    return {
      backend: createHttpFetchBackend({ timeoutMs: settings.timeoutMs }),
      unavailableReason: null,
      fallbackFrom: 'provider',
    };
  }

  return {
    backend: null,
    unavailableReason:
      'provider-hosted WebFetch is unavailable: the selected model provider has no API key, ' +
      'or its base URL cannot serve the web API. Use `auto` to fall back to the local backend, ' +
      'or set web.fetch.provider to "http" explicitly (it can reach intranet addresses).',
    fallbackFrom: null,
  };
}

/** Upstream error bodies are usually a small JSON error; cap before parsing. */
const ERROR_BODY_CHARS = 2_000;

/**
 * Keep the provider's error message (401 vs 429 vs 400) instead of a bare status
 * code. Reads at most {@link ERROR_BODY_CHARS}, redacts credentials and caps the
 * final message, so a misbehaving endpoint cannot flood the tool result.
 */
async function readErrorDetail(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  try {
    while (raw.length < ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch {
    return '';
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const message = extractProviderMessage(raw).replace(/\s+/g, ' ').trim();
  return sanitizeErrorMessage(message).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
