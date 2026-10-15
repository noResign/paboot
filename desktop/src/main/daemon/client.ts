import type { DaemonRequest, DaemonResponse } from '../../shared/ipc';
import type { HealthDto } from '../../shared/contract';

export interface DaemonTarget {
  baseUrl: string;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Join a `/api/...` path onto a base URL, dropping empty query values. */
export function buildUrl(baseUrl: string, path: string, query?: DaemonRequest['query']): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Probe `/api/health`, which is deliberately unauthenticated. */
export async function probeHealth(baseUrl: string, timeoutMs = 1000): Promise<HealthDto | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(buildUrl(baseUrl, '/api/health'), { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<HealthDto>;
    if (data?.service !== 'paboot') return null;
    return {
      ok: data.ok !== false,
      service: 'paboot',
      version: typeof data.version === 'string' ? data.version : 'unknown',
      workspace: typeof data.workspace === 'string' ? data.workspace : null,
      // Absent from older daemons — left off entirely rather than set to
      // undefined, so "unknown" stays distinguishable from "empty".
      ...(typeof data.serverId === 'string' && data.serverId ? { serverId: data.serverId } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Authenticated JSON client for one daemon target. Network failures come back
 * as a synthetic `{ status: 0 }` response rather than a rejected promise, so the
 * renderer's typed facade only ever deals with one shape.
 */
export class DaemonClient {
  constructor(private readonly target: DaemonTarget) {}

  get baseUrl(): string {
    return this.target.baseUrl;
  }

  /**
   * Open a raw response without reading it — used by the streamer, which needs
   * the body as a stream rather than a parsed value.
   */
  open(req: Omit<DaemonRequest, 'connectionId'>, signal: AbortSignal): Promise<Response> {
    const hasBody = req.body !== undefined;
    return fetch(buildUrl(this.target.baseUrl, req.path, req.query), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${this.target.token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal,
    });
  }

  /**
   * A client already belongs to one connection, so it does not need to be told
   * which daemon a request is for — main's IPC layer strips that field before
   * handing the request over.
   */
  async request<T = unknown>(req: Omit<DaemonRequest, 'connectionId'>): Promise<DaemonResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await this.open(req, controller.signal);
      const text = await res.text();
      return { status: res.status, ok: res.ok, data: parseBody(text) as T };
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return {
        status: 0,
        ok: false,
        data: {
          error: aborted ? 'timeout' : 'network_error',
          message: aborted ? '请求超时' : (err as Error).message,
        } as T,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
