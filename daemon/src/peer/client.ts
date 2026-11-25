import type { PeerInfoDto, PeerRedeemDto } from '../types/api.js';
import { PeerValidationError } from './contract.js';

const PROBE_TIMEOUT_MS = 3_000;

/** Parse a `paboot://join?host&port&fp&t&exp` link. */
export interface PeerInvite {
  baseUrl: string;
  token: string;
  fingerprint: string;
  expiresAt: number | null;
}

export function parseInvite(url: string): PeerInvite {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new PeerValidationError('invalid invite url', 'invalid_invite');
  }
  if (parsed.protocol !== 'paboot:' || parsed.hostname !== 'join') {
    throw new PeerValidationError('invalid invite url', 'invalid_invite');
  }
  const host = parsed.searchParams.get('host')?.trim() ?? '';
  const port = parsed.searchParams.get('port')?.trim() ?? '';
  const token = parsed.searchParams.get('t')?.trim() ?? '';
  const fingerprint = parsed.searchParams.get('fp')?.trim() ?? '';
  if (!host || !port || !token) {
    throw new PeerValidationError('invite is missing host/port/token', 'invalid_invite');
  }
  const expires = Number(parsed.searchParams.get('exp') ?? '');
  return {
    baseUrl: httpBase(host, port),
    token,
    fingerprint,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null,
  };
}

export async function probePeer(baseUrl: string, token?: string): Promise<PeerInfoDto> {
  const res = await fetchWithTimeout(
    `${baseUrl}/api/peer/info`,
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    PROBE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const code = res.status === 401 ? 'unauthorized' : 'agent_offline';
    throw new PeerValidationError(`peer probe failed (HTTP ${res.status})`, code, 503);
  }
  return (await res.json()) as PeerInfoDto;
}

export async function redeemPeer(
  baseUrl: string,
  token: string,
  input: { peerId: string; label: string },
): Promise<PeerRedeemDto> {
  const res = await fetchWithTimeout(
    `${baseUrl}/api/peer/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    },
    PROBE_TIMEOUT_MS * 2,
  );
  if (res.status === 410) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    throw new PeerValidationError('invite expired or already used', body.code ?? 'invite_expired', 410);
  }
  if (!res.ok) {
    throw new PeerValidationError(`peer redeem failed (HTTP ${res.status})`, 'agent_offline', 503);
  }
  return (await res.json()) as PeerRedeemDto;
}

/** Start (or idempotently re-attach to) a run on A; resolves to the SSE body. */
export async function openPeerRun(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/peer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new PeerValidationError(
      `peer unreachable: ${error instanceof Error ? error.message : String(error)}`,
      'agent_offline',
      503,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new PeerValidationError(
      `peer rejected the run (HTTP ${response.status})${text ? `: ${text}` : ''}`,
      'peer_run_rejected',
      response.status === 401 ? 401 : 502,
    );
  }
  return response;
}

export async function cancelPeerRun(
  baseUrl: string,
  token: string,
  remoteRunId: string,
): Promise<void> {
  await fetch(`${baseUrl}/api/peer/runs/${remoteRunId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}

export async function relayPermissionDecision(
  baseUrl: string,
  token: string,
  remoteRunId: string,
  permissionId: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  await fetch(`${baseUrl}/api/peer/runs/${remoteRunId}/permission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ permissionId, decision }),
  });
}

/** Parse a peer SSE body into `{seq,event}` records. */
export async function* readPeerFrames(
  response: Response,
): AsyncGenerator<{ seq: number; event: Record<string, unknown> }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            const parsed = JSON.parse(data) as { seq?: number; event?: Record<string, unknown> };
            if (parsed.event && typeof parsed.event === 'object') {
              yield { seq: Number(parsed.seq ?? 0), event: parsed.event };
            }
          } catch {
            // Ignore a malformed frame; the next one carries the stream forward.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PeerValidationError(`peer unreachable: ${reason}`, 'agent_offline', 503);
  } finally {
    clearTimeout(timer);
  }
}

function httpBase(host: string, port: string): string {
  const bare = host.replace(/^\[|\]$/g, '');
  const dial = bare.includes(':') ? `[${bare}]` : bare;
  return `http://${dial}:${port}`;
}
