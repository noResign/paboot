import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { requireAuth } from '../src/http/auth';

const TOKEN = 'correct-token';

interface CallResult {
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
  passed: boolean;
}

function call(handler: RequestHandler, ip: string, authorization?: string): CallResult {
  const result: CallResult = { status: null, body: null, headers: {}, passed: false };
  const req = {
    ip,
    socket: { remoteAddress: ip },
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as Request;
  const res = {
    setHeader(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  } as unknown as Response;
  handler(req, res, (() => {
    result.passed = true;
  }) as NextFunction);
  return result;
}

describe('requireAuth throttle', () => {
  it('lets the correct token through', () => {
    const handler = requireAuth(TOKEN);
    const result = call(handler, '10.0.0.1', `Bearer ${TOKEN}`);
    expect(result.passed).toBe(true);
    expect(result.status).toBeNull();
  });

  it('locks a source out after 5 consecutive wrong tokens', () => {
    let now = 1_000;
    const handler = requireAuth(TOKEN, { maxFailures: 5, lockoutMs: 60_000, now: () => now });

    for (let i = 0; i < 4; i += 1) {
      const result = call(handler, '10.0.0.1', 'Bearer wrong');
      expect(result.status).toBe(401);
      expect(result.passed).toBe(false);
    }

    const fifth = call(handler, '10.0.0.1', 'Bearer wrong');
    expect(fifth.status).toBe(429);
    expect(fifth.headers['retry-after']).toBe('60');

    // Even the real token is refused while the cooldown is active.
    const duringLock = call(handler, '10.0.0.1', `Bearer ${TOKEN}`);
    expect(duringLock.status).toBe(429);
    expect(duringLock.passed).toBe(false);

    now += 60_000;
    const afterCooldown = call(handler, '10.0.0.1', `Bearer ${TOKEN}`);
    expect(afterCooldown.passed).toBe(true);
  });

  it('resets the failure count on a successful auth', () => {
    const handler = requireAuth(TOKEN, { maxFailures: 3 });
    expect(call(handler, '10.0.0.2', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.2', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.2', `Bearer ${TOKEN}`).passed).toBe(true);
    expect(call(handler, '10.0.0.2', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.2', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.2', `Bearer ${TOKEN}`).passed).toBe(true);
  });

  it('doubles the cooldown on repeated lockouts', () => {
    let now = 0;
    const handler = requireAuth(TOKEN, { maxFailures: 2, lockoutMs: 1_000, now: () => now });
    const fail = (): CallResult => call(handler, '10.0.0.3', 'Bearer wrong');

    expect(fail().status).toBe(401);
    expect(fail().headers['retry-after']).toBe('1');

    now += 1_000;
    expect(fail().status).toBe(401);
    const second = fail();
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('2');
  });

  it('tracks each source independently', () => {
    const handler = requireAuth(TOKEN, { maxFailures: 2 });
    expect(call(handler, '10.0.0.4', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.4', 'Bearer wrong').status).toBe(429);
    expect(call(handler, '10.0.0.5', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.5', 'Bearer wrong').status).toBe(429);
  });

  it('treats IPv4-mapped IPv6 and plain IPv4 as the same source', () => {
    const handler = requireAuth(TOKEN, { maxFailures: 2 });
    expect(call(handler, '::ffff:10.0.0.6', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.6', 'Bearer wrong').status).toBe(429);
  });

  it('does not count requests that carry no bearer token', () => {
    const handler = requireAuth(TOKEN, { maxFailures: 2 });
    for (let i = 0; i < 10; i += 1) {
      expect(call(handler, '10.0.0.7').status).toBe(401);
    }
    expect(call(handler, '10.0.0.7', 'Bearer wrong').status).toBe(401);
    expect(call(handler, '10.0.0.7', `Bearer ${TOKEN}`).passed).toBe(true);
  });

  it('can be disabled with maxFailures = 0', () => {
    const handler = requireAuth(TOKEN, { maxFailures: 0 });
    for (let i = 0; i < 20; i += 1) {
      expect(call(handler, '10.0.0.8', 'Bearer wrong').status).toBe(401);
    }
    expect(call(handler, '10.0.0.8', `Bearer ${TOKEN}`).passed).toBe(true);
  });
});
