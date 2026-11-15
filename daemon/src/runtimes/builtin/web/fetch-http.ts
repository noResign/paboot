import { WebFetchError, type FetchBackend, type FetchedPage } from './fetch.js';
import { convertHtmlToMarkdown } from './html.js';

/**
 * The local HTTP(S) fetch backend: requests go out from the daemon process, so
 * unlike the provider-hosted backend it *can* reach intranet and loopback
 * addresses. That is the point of it, and why `auto` only reaches for it as a
 * fallback — turning it on widens the network exposure of an agent that already
 * has shell access, so the switch is logged.
 *
 * Bodies decoded: `text/*`, JSON, XML and HTML. HTML is converted to Markdown
 * (see `html.ts`): raw markup is enormous, and cutting it with the token budget
 * would slice through tags. PDFs, images and other binaries are refused.
 */

/** Rejected before a request is made; long URLs are usually an attack or a bug. */
export const HTTP_FETCH_MAX_URL_LENGTH = 2048;
/** Hard cap on bytes pulled off the socket. */
export const HTTP_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Cap on the decoded text handed to the tool. */
export const HTTP_FETCH_MAX_BODY_CHARS = 200_000;
/** Same-origin hops followed before giving up. */
export const HTTP_FETCH_MAX_REDIRECTS = 3;
const USER_AGENT = 'paboot-webfetch/1.0';
const ACCEPT = 'text/html;q=0.9,text/*;q=0.9,application/json;q=0.9,application/xml;q=0.9,*/*;q=0.5';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface HttpFetchLimits {
  timeoutMs: number;
  maxUrlLength?: number;
  maxResponseBytes?: number;
  maxBodyChars?: number;
  maxRedirects?: number;
}

/**
 * Parse a request URL and enforce the network-independent restrictions: http(s)
 * only, no embedded credentials, bounded length. Credentialed URLs are refused
 * because they would put a secret into a URL that errors and logs may echo.
 */
export function parseHttpFetchUrl(input: string, maxUrlLength = HTTP_FETCH_MAX_URL_LENGTH): URL {
  if (input.length > maxUrlLength) {
    throw new WebFetchError(`URL exceeds the maximum length of ${maxUrlLength}`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebFetchError(`invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebFetchError('credentials in URLs are not allowed');
  }
  return url;
}

/** Same scheme, host and port; a redirect crossing origins needs its own call. */
export function isSameHttpOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

export type FetchableKind = 'text' | 'html';

/**
 * Classify a `Content-Type`. HTML is reported separately rather than lumped
 * into text so the caller can explain why it is refused instead of returning
 * markup as if it were prose.
 */
export function classifyFetchContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json' || mime === 'application/xml') return 'text';
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return 'text';
  return undefined;
}

/** Declared charset, defaulting to UTF-8. */
export function decoderForCharset(contentType: string | null): InstanceType<typeof TextDecoder> {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '');
  const declared = match?.[1]?.trim().toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(declared);
  } catch {
    throw new WebFetchError(`unsupported charset "${declared}"`);
  }
}

/**
 * The anonymous local fetch backend. No cookies, no `Authorization`, no
 * ambient proxy credentials beyond what the process already uses.
 */
export function createHttpFetchBackend(limits: HttpFetchLimits): FetchBackend {
  const maxUrlLength = limits.maxUrlLength ?? HTTP_FETCH_MAX_URL_LENGTH;
  const maxBytes = limits.maxResponseBytes ?? HTTP_FETCH_MAX_RESPONSE_BYTES;
  const maxChars = limits.maxBodyChars ?? HTTP_FETCH_MAX_BODY_CHARS;
  const maxRedirects = limits.maxRedirects ?? HTTP_FETCH_MAX_REDIRECTS;
  return {
    id: 'http',
    async fetch(url, signal): Promise<FetchedPage> {
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      let current = parseHttpFetchUrl(url, maxUrlLength);
      for (let hop = 0; ; hop += 1) {
        let response: Response;
        try {
          response = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'user-agent': USER_AGENT, accept: ACCEPT },
            signal: combined,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new WebFetchError(
            timeout.aborted
              ? `web fetch timed out after ${limits.timeoutMs}ms`
              : `web fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (REDIRECT_STATUS.has(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (location === null) {
            throw new WebFetchError(`redirect response (HTTP ${response.status}) without a Location header`);
          }
          if (hop >= maxRedirects) {
            throw new WebFetchError(`exceeded the maximum of ${maxRedirects} redirects`);
          }
          const next = parseHttpFetchUrl(new URL(location, current).toString(), maxUrlLength);
          if (!isSameHttpOrigin(next, current)) {
            throw new WebFetchError(
              `cross-origin redirect to ${next.origin} is not followed automatically; ` +
                'retry against that URL directly',
            );
          }
          current = next;
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new WebFetchError(`web fetch failed: HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        const kind = classifyFetchContentType(contentType);
        if (kind === undefined) {
          await response.body?.cancel().catch(() => undefined);
          throw new WebFetchError(
            `unsupported content type "${contentType ?? 'unknown'}"; the local backend decodes ` +
              'text, JSON, XML and HTML only',
          );
        }

        const decoder = decoderForCharset(contentType);
        const { bytes, truncated } = await readCapped(
          response,
          maxBytes,
          combined,
          signal,
          timeout,
          limits.timeoutMs,
        );
        let decoded: string;
        try {
          // A byte-capped body may cut a multi-byte character in half; only then
          // is an incomplete trailing sequence legitimate.
          decoded = decoder.decode(bytes, { stream: truncated });
        } catch {
          throw new WebFetchError('response body could not be decoded with its declared charset');
        }

        // HTML is converted to Markdown before it reaches the model: raw markup
        // is both enormous and useless as prose, and token-truncating it would
        // cut through tags.
        if (kind === 'html') {
          return { content: convertHtmlToMarkdown(decoded, { maxChars }).text };
        }
        const content = decoded.length > maxChars ? decoded.slice(0, maxChars) : decoded;
        return { content };
      }
    },
  };
}

/**
 * Read up to `maxBytes`. A declared oversize `Content-Length` is rejected before
 * reading; a stream that grows past the cap is cut short, so a server that
 * under-reports still yields a bounded usable body.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  combined: AbortSignal,
  callerSignal: AbortSignal,
  timeout: AbortSignal,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebFetchError(`response exceeds the maximum of ${maxBytes} bytes`);
    }
  }
  if (response.body === null) return { bytes: new Uint8Array(0), truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    if (callerSignal.aborted) throw error;
    throw new WebFetchError(
      timeout.aborted
        ? `web fetch timed out after ${timeoutMs}ms`
        : `web fetch failed while reading the body: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Best-effort cleanup; the bytes we need are already collected.
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (truncated && combined.aborted) {
    throw new WebFetchError(`web fetch timed out after ${timeoutMs}ms`);
  }
  return { bytes, truncated };
}
