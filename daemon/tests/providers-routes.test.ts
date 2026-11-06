import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '../src/app/context';
import { ProviderManager } from '../src/providers/provider-manager';
import { registerProviderRoutes } from '../src/routes/providers';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-providers-'));
  dirs.push(dir);
  return path.join(dir, 'providers.json');
}

async function start(options: { providersFile?: string; fetch?: typeof fetch }) {
  const providersFile = options.providersFile ?? tempFile();
  const manager = new ProviderManager({
    providersFile,
    env: {},
    fetch: options.fetch,
    testTimeoutMs: 1_000,
  });
  const invalidate = vi.fn();
  const app = express();
  app.use(express.json());
  registerProviderRoutes(app, {
    providers: manager,
    registry: { invalidate },
  } as unknown as AppContext);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    providersFile,
    manager,
    invalidate,
  };
}

describe('provider management API', () => {
  it('lists built-in providers without exposing keys', async () => {
    const h = await start({});
    const response = await fetch(`${h.base}/api/providers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Array<Record<string, unknown>> };
    expect(body.providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai', 'deepseek']);
    expect(body.providers.find((provider) => provider.id === 'deepseek')).toMatchObject({
      builtin: true,
      hasApiKey: false,
      apiKeySource: null,
    });
    expect(JSON.stringify(body)).not.toContain('"apiKey":');
  });

  it('creates, patches and deletes a custom provider', async () => {
    const h = await start({});
    const created = await fetch(`${h.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'local-fast',
        kind: 'openai',
        label: 'Local Fast',
        baseUrl: 'http://127.0.0.1:9999',
        apiKey: 'secret-key',
        models: [{
          id: 'fast-model',
          label: 'Fast',
          supportsTools: true,
          supportsImages: true,
        }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { provider: Record<string, unknown> };
    expect(createdBody.provider).toMatchObject({
      id: 'local-fast',
      builtin: false,
      hasApiKey: true,
      apiKeySource: 'file',
    });
    expect(JSON.stringify(createdBody)).not.toContain('secret-key');
    expect(h.invalidate).toHaveBeenCalledWith('builtin');

    const patched = await fetch(`${h.base}/api/providers/local-fast`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed' }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).provider).toMatchObject({
      id: 'local-fast',
      label: 'Renamed',
      hasApiKey: true,
    });

    const cleared = await fetch(`${h.base}/api/providers/local-fast`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: null }),
    });
    expect((await cleared.json()).provider).toMatchObject({ hasApiKey: false });
    expect(JSON.parse(fs.readFileSync(h.providersFile, 'utf8')).providers[0].apiKey).toBeNull();

    const deleted = await fetch(`${h.base}/api/providers/local-fast`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const list = (await (await fetch(`${h.base}/api/providers`)).json()) as {
      providers: Array<{ id: string }>;
    };
    expect(list.providers.map((provider) => provider.id)).not.toContain('local-fast');
  });

  it('keeps model prices when a client edits models without sending price', async () => {
    const h = await start({});
    const created = await fetch(`${h.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'priced',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9999',
        apiKey: 'secret-key',
        models: [{
          id: 'priced-model',
          price: { inputPerMTok: 1, outputPerMTok: 2 },
        }],
      }),
    });
    expect(created.status).toBe(201);

    const patched = await fetch(`${h.base}/api/providers/priced`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: [{ id: 'priced-model', supportsTools: true }] }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).provider.models).toEqual([
      {
        id: 'priced-model',
        supportsTools: true,
        price: { inputPerMTok: 1, outputPerMTok: 2 },
      },
    ]);
  });

  it('rejects duplicate ids and deleting built-in providers', async () => {
    const h = await start({});
    const duplicate = await fetch(`${h.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'deepseek', kind: 'openai', baseUrl: 'https://example.com' }),
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe('provider_exists');

    const builtinDelete = await fetch(`${h.base}/api/providers/deepseek`, { method: 'DELETE' });
    expect(builtinDelete.status).toBe(409);
    expect((await builtinDelete.json()).code).toBe('provider_is_builtin');
  });

  it('tests connectivity and refreshes the remote model directory', async () => {
    const models = [{ id: 'remote-one' }, { id: 'remote-two' }];
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ data: models }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const h = await start({ fetch: fakeFetch });
    await h.manager.create({
      id: 'remote',
      kind: 'openai',
      label: 'Remote',
      baseUrl: 'https://provider.example',
      apiKey: 'secret',
      models: [{ id: 'remote-one', label: 'Existing', supportsTools: true, supportsImages: true }],
    });

    const tested = await fetch(`${h.base}/api/providers/remote/test`, { method: 'POST' });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, status: 200, modelCount: 2 });

    const refreshed = await fetch(`${h.base}/api/providers/remote/models/refresh`, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    const refreshedBody = (await refreshed.json()) as { provider: { models: Array<Record<string, unknown>> } };
    expect(refreshedBody.provider.models.map((model) => model.id)).toEqual(['remote-one', 'remote-two']);
    expect(refreshedBody.provider.models[0]).toMatchObject({
      id: 'remote-one',
      label: 'Existing',
      supportsImages: true,
    });
    expect(refreshedBody.provider.models[1]).toMatchObject({
      id: 'remote-two',
      supportsTools: true,
      supportsImages: false,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });
});
