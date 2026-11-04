import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRoleAllowed, requireAuth, requireRolePolicy } from '../src/http/auth';

const OPERATOR = 'operator-token';
const AGENT = 'agent-token';
const SERVER = 'server-token';
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(
    '/api',
    requireAuth(OPERATOR, {
      agentToken: AGENT,
      serverToken: SERVER,
      maxFailures: 0,
    }),
  );
  app.use('/api', requireRolePolicy());
  app.get('/api/public', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/public', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/internal/permissions/create', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/internal/permissions/x/status', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/internal/mcp/schedule', (_req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function call(method: string, path: string, token: string): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.text();
  return res.status;
}

describe('token roles', () => {
  it('operator keeps full access', async () => {
    expect(await call('GET', '/api/public', OPERATOR)).toBe(200);
    expect(await call('POST', '/api/public', OPERATOR)).toBe(200);
    expect(await call('POST', '/api/internal/mcp/schedule', OPERATOR)).toBe(200);
  });

  it('agent is read-only on the public API', async () => {
    expect(await call('GET', '/api/public', AGENT)).toBe(200);
    expect(await call('POST', '/api/public', AGENT)).toBe(403);
  });

  it('agent may use the permission-hook internal endpoints', async () => {
    expect(await call('POST', '/api/internal/permissions/create', AGENT)).toBe(200);
    expect(await call('GET', '/api/internal/permissions/x/status', AGENT)).toBe(200);
  });

  it('agent cannot call internal MCP writes', async () => {
    expect(await call('POST', '/api/internal/mcp/schedule', AGENT)).toBe(403);
  });

  it('server is limited to internal endpoints', async () => {
    expect(await call('POST', '/api/internal/mcp/schedule', SERVER)).toBe(200);
    expect(await call('GET', '/api/public', SERVER)).toBe(403);
    expect(await call('POST', '/api/public', SERVER)).toBe(403);
  });

  it('rejects unknown tokens and distinguishes role rules', async () => {
    expect(await call('GET', '/api/public', 'nope')).toBe(401);
    expect(isRoleAllowed('agent', 'GET', '/api/public')).toBe(true);
    expect(isRoleAllowed('agent', 'POST', '/api/public')).toBe(false);
    expect(isRoleAllowed('server', 'POST', '/api/internal/x')).toBe(true);
    expect(isRoleAllowed('server', 'GET', '/api/public')).toBe(false);
  });
});
