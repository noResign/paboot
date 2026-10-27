import { randomUUID } from 'node:crypto';
import { log } from '../platform/log.js';
import { toGrantKey } from './tool-grants.js';
import type { PermissionStatus } from '../types/api.js';

export type PermissionDecision = 'allow' | 'deny';

/** `decisionReason` written when the operator chose "allow all" for a grant key. */
export const ALLOW_ALL_REASON = 'allow all';

export interface PermissionRequest {
  id: string;
  runId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  status: PermissionStatus;
  decisionReason: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** 是否已经把 pending 请求广播给客户端；只有广播过的请求才需要在解决时再发状态帧。 */
  announced: boolean;
  /** User input is held in memory only, never included in DTOs or SSE. */
  response?: unknown;
  validateResponse?: (response: unknown) => string | null;
}

/**
 * In-memory registry of pending tool-permission requests. Grants themselves are
 * persisted by `Db` (`session_permission_grants`); this class only tracks asks
 * that are waiting for a decision so timeouts and queue cleanup stay simple.
 */
export class PermissionManager {
  private readonly pending = new Map<string, PermissionRequest>();
  /**
   * Callers blocked on a decision (see `wait`). Keyed by request id and dropped
   * as soon as the request settles, so a settled request never holds a waiter.
   */
  private readonly waiters = new Map<string, Array<(req: PermissionRequest) => void>>();
  private readonly timeoutMs: number;
  private readonly onResolved?: (req: PermissionRequest) => void;

  constructor(timeoutMs = 120_000, onResolved?: (req: PermissionRequest) => void) {
    this.timeoutMs = timeoutMs;
    this.onResolved = onResolved;
  }

  create(runId: string, sessionId: string, toolName: string, toolInput: unknown): PermissionRequest {
    const req: PermissionRequest = {
      id: randomUUID(),
      runId,
      sessionId,
      toolName,
      toolInput,
      status: 'pending',
      decisionReason: null,
      createdAt: Date.now(),
      decidedAt: null,
      announced: false,
    };
    this.pending.set(req.id, req);
    setTimeout(() => {
      if (req.status === 'pending') {
        this.resolve(req, 'timed_out', 'timed out waiting for approval');
        log.warn(`permission ${req.id} (${req.toolName}) timed out -> deny`);
      }
    }, this.timeoutMs).unref();
    return req;
  }

  get(id: string): PermissionRequest | undefined {
    return this.pending.get(id);
  }

  decide(id: string, decision: PermissionDecision, reason?: string, response?: unknown): PermissionRequest | undefined {
    const req = this.pending.get(id);
    if (!req) return undefined;
    if (req.status !== 'pending') return req; // idempotent: already decided
    req.response = response;
    const status: PermissionStatus = decision === 'allow' ? 'allowed' : 'denied';
    this.resolve(req, status, reason ?? (decision === 'allow' ? null : 'denied by user'));
    return req;
  }

  /**
   * Resolve when `id` settles — decided, timed out, or cleared. This is what
   * lets a runtime whose approval is a *blocking call on its own transport*
   * hold the provider's request open: Codex keeps the tool call pending until
   * this promise settles, then answers it. The Claude path never needs this
   * because its hook subprocess polls `/status` instead.
   */
  wait(id: string): Promise<PermissionRequest> {
    const req = this.pending.get(id);
    if (!req) return Promise.reject(new Error(`permission ${id} is not pending`));
    if (req.status !== 'pending') return Promise.resolve(req);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? [];
      waiters.push(resolve);
      this.waiters.set(id, waiters);
    });
  }

  private resolve(req: PermissionRequest, status: PermissionStatus, reason: string | null): void {
    req.status = status;
    req.decisionReason = reason;
    req.decidedAt = Date.now();
    const waiters = this.waiters.get(req.id);
    if (waiters) {
      this.waiters.delete(req.id);
      for (const notify of waiters) notify(req);
    }
    try {
      this.onResolved?.(req);
    } catch (err) {
      // 写回 events 表只影响重连回放的准确性，失败不应阻断审批本身
      log.warn(`failed to persist permission resolution for ${req.id}`, err);
    }
  }

  /**
   * Resolve already-pending asks covered by the same grant key in the same
   * session — every MCP tool of a server for `mcp__<server>__*`, otherwise the
   * exact tool. The persistent grant itself is written by the route before
   * calling this.
   */
  allowAll(sessionId: string, grantKey: string): void {
    for (const req of this.pending.values()) {
      if (req.sessionId === sessionId && req.status === 'pending' && toGrantKey(req.toolName) === grantKey) {
        this.resolve(req, 'allowed', ALLOW_ALL_REASON);
      }
    }
  }

  /** Forget a run's pending requests; deny any still-pending ask first. */
  clearRun(runId: string): void {
    for (const [id, req] of this.pending) {
      if (req.runId !== runId) continue;
      if (req.status === 'pending') {
        this.resolve(req, 'denied', 'run ended before approval');
      }
      this.pending.delete(id);
    }
  }

  /** Forget a session's pending requests; deny any still-pending ask first. */
  clearSession(sessionId: string): void {
    for (const [id, req] of this.pending) {
      if (req.sessionId !== sessionId) continue;
      if (req.status === 'pending') {
        this.resolve(req, 'denied', 'session deleted before approval');
      }
      this.pending.delete(id);
    }
  }
}
