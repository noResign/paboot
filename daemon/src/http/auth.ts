import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { log } from '../platform/log.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Consecutive wrong-token attempts before a client is locked out. */
export const DEFAULT_MAX_FAILURES = 5;
/** First lockout duration; each further lockout doubles it. */
export const DEFAULT_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;
/** Forget an idle client after this long so escalation does not last forever. */
const IDLE_RESET_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
/** Bound the map: a token flood with rotating source addresses must not grow it without limit. */
const MAX_TRACKED_CLIENTS = 10_000;

export interface AuthThrottleOptions {
  /** `0` disables lockouts entirely. */
  maxFailures?: number;
  lockoutMs?: number;
  now?: () => number;
}

interface AttemptState {
  failures: number;
  lockedUntil: number;
  lockouts: number;
  lastSeen: number;
}

export interface FailureResult {
  locked: boolean;
  retryAfterMs: number;
}

/**
 * Per-source failure counter and cooldown. The bearer token is 256 bits, so
 * brute force is already infeasible; this exists to stop a scanner from
 * hammering the port and to make repeated guessing expensive.
 */
export class AuthThrottle {
  private readonly states = new Map<string, AttemptState>();
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private lastCleanup: number;

  constructor(options: AuthThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;
    this.now = options.now ?? Date.now;
    this.lastCleanup = this.now();
  }

  /** Remaining lockout in ms; `0` means the request may be attempted. */
  blockedFor(key: string): number {
    const now = this.now();
    this.maybeCleanup(now);
    const state = this.states.get(key);
    if (!state || state.lockedUntil <= now) return 0;
    return state.lockedUntil - now;
  }

  recordFailure(key: string): FailureResult {
    if (this.maxFailures <= 0) return { locked: false, retryAfterMs: 0 };
    const now = this.now();
    this.maybeCleanup(now);
    const state = this.stateFor(key, now);
    state.failures += 1;
    state.lastSeen = now;
    if (state.failures < this.maxFailures) return { locked: false, retryAfterMs: 0 };

    const duration = Math.min(this.lockoutMs * 2 ** state.lockouts, MAX_LOCKOUT_MS);
    state.failures = 0;
    state.lockedUntil = now + duration;
    state.lockouts += 1;
    return { locked: true, retryAfterMs: duration };
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  private stateFor(key: string, now: number): AttemptState {
    const existing = this.states.get(key);
    if (existing) return existing;
    if (this.states.size >= MAX_TRACKED_CLIENTS) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    const state: AttemptState = { failures: 0, lockedUntil: 0, lockouts: 0, lastSeen: now };
    this.states.set(key, state);
    return state;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [key, state] of this.states) {
      if (state.lockedUntil <= now && now - state.lastSeen > IDLE_RESET_MS) this.states.delete(key);
    }
  }
}

/**
 * Best-effort client identity for throttling: the socket peer, never
 * `X-Forwarded-For` (the daemon is normally reached directly, and trusting a
 * client-supplied header would let an attacker rotate the key at will).
 */
export function clientKey(req: Request): string {
  const raw = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

/**
 * Bearer-token gate for all `/api/*` routes except the health probe. The token
 * is a single shared secret (env `PABOOT_TOKEN` or the persisted file under
 * the data dir). Wrong tokens are counted per source client: after
 * `maxFailures` consecutive failures that source gets `429` + `Retry-After`
 * until the cooldown (doubling on repeat offences) expires. A successful auth
 * clears the counter.
 *
 * This is the minimum viable remote-auth layer; a multi-user deployment should
 * replace it with OIDC/SSO + per-user tokens.
 */
export function requireAuth(token: string, options: AuthThrottleOptions = {}): RequestHandler {
  const throttle = new AuthThrottle(options);

  return (req, res, next) => {
    const key = clientKey(req);
    const blockedMs = throttle.blockedFor(key);
    if (blockedMs > 0) {
      sendLocked(res, blockedMs);
      return;
    }

    const header = req.headers.authorization;
    const provided = header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (provided && safeEqual(provided, token)) {
      throttle.recordSuccess(key);
      next();
      return;
    }

    if (provided) {
      const failure = throttle.recordFailure(key);
      if (failure.locked) {
        log.warn(`${key} locked out for ${Math.ceil(failure.retryAfterMs / 1000)}s after repeated auth failures`);
        sendLocked(res, failure.retryAfterMs);
        return;
      }
      log.warn(`failed authentication attempt from ${key}`);
    }

    res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
  };
}

function sendLocked(res: Response, retryAfterMs: number): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: 'too many failed authentication attempts',
    code: 'too_many_attempts',
    retryAfterSeconds,
  });
}
