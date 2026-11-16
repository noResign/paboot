import type { BuiltinRuntimeConfig } from '../config.js';
import {
  providerFetchBaseUrl,
  readErrorDetail,
  type ProviderEndpoint,
} from './fetch.js';

export interface WebSearchResult {
  title: string;
  url: string;
  /** Short teaser, typically 100–200 characters. */
  snippet: string;
  /** Long summary, typically 600–800 characters; what the model reads first. */
  summary: string;
  siteName: string | null;
  /** RFC 3339 UTC timestamp or null when unknown. */
  publishedAt: string | null;
  /** Provider authority score, -1 when unknown. */
  authority: number | null;
  /** Provider rerank score, 0–3. */
  score: number | null;
}

/** One web-search backend. The tool only sees this interface. */
export interface SearchBackend {
  readonly id: 'provider';
  search(query: string, count: number, signal: AbortSignal): Promise<WebSearchResult[]>;
}

export interface SearchBackendSelection {
  backend: SearchBackend | null;
  /** Why nothing is usable; surfaced by the tool when config asked for it. */
  unavailableReason: string | null;
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

/** Provider limits; mirrored here so bad input fails locally instead of as a 400. */
export const MAX_SEARCH_QUERY_CHARS = 128;
export const MAX_SEARCH_COUNT = 50;

/**
 * Provider-hosted search: `POST <webApiBase>/search`. Runs on the provider's
 * servers, so it cannot reach intranet or loopback addresses. Returns result
 * metadata and summaries, never full page text — that is what fetch is for.
 */
export function createProviderSearchBackend(input: {
  /** The web API base (already `/v1/tools`), not the completions base. */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}): SearchBackend {
  const endpoint = `${input.baseUrl.replace(/\/+$/, '')}/search`;
  return {
    id: 'provider',
    async search(query, count, signal) {
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
          body: JSON.stringify({ query, count }),
          signal: combined,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new WebSearchError(
          timeout.aborted
            ? `web search timed out after ${input.timeoutMs}ms`
            : `web search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new WebSearchError(
          `web search failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new WebSearchError('web search returned a non-JSON response');
      }
      if (!isRecord(payload) || !Array.isArray(payload['results'])) {
        throw new WebSearchError('web search returned an invalid response body');
      }
      const results: WebSearchResult[] = [];
      for (const raw of payload['results']) {
        const parsed = parseResult(raw);
        if (parsed) results.push(parsed);
      }
      return results;
    },
  };
}

/**
 * Resolve the search backend from config. There is no local fallback: search
 * only exists on the provider side, so nothing is registered without a usable
 * key and web API base.
 */
export function resolveSearchBackend(input: {
  settings: BuiltinRuntimeConfig['web']['search'];
  provider: ProviderEndpoint;
}): SearchBackendSelection {
  const { settings, provider } = input;
  if (!settings.enabled) return { backend: null, unavailableReason: null };

  const apiKey = provider.apiKey;
  const webApiBase = settings.baseUrl ?? providerFetchBaseUrl(provider.baseUrl);
  if (!apiKey || apiKey.length === 0 || webApiBase === null) {
    return {
      backend: null,
      unavailableReason:
        'web search is unavailable: the selected model provider has no API key, or its base ' +
        'URL cannot serve the web API.',
    };
  }
  return {
    backend: createProviderSearchBackend({
      baseUrl: webApiBase,
      apiKey,
      timeoutMs: settings.timeoutMs,
    }),
    unavailableReason: null,
  };
}

function parseResult(raw: unknown): WebSearchResult | null {
  if (!isRecord(raw)) return null;
  const title = readString(raw, 'title');
  const url = readString(raw, 'url');
  if (!title || !url) return null;
  return {
    title,
    url,
    snippet: readString(raw, 'snippet') ?? '',
    summary: readString(raw, 'summary') ?? '',
    siteName: readString(raw, 'site_name'),
    publishedAt: readString(raw, 'date'),
    authority: readNumber(raw, 'authority'),
    score: readNumber(raw, 'rerank_score'),
  };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
