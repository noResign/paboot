import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { configuredMemoryModel } from '../src/memory/model';
import { SETTING_DEFAULT_PERMISSION_MODE } from '../src/permissions/permission-mode';
import { ProviderManager } from '../src/providers/provider-manager';
import { registerConfigRoutes } from '../src/routes/config';

const dbs: Db[] = [];
const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup(envFallback: string | null = null): Promise<{ url: string; db: Db; ctx: AppContext }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-model-'));
  tmpDirs.push(dir);
  const db = new Db(':memory:');
  dbs.push(db);
  const providers = new ProviderManager({
    env: {
      PABOOT_LLM_PROVIDERS: JSON.stringify([
        {
          id: 'fake',
          kind: 'openai',
          baseUrl: 'http://127.0.0.1:1',
          apiKey: 'test-key',
          models: [{ id: 'm1' }, { id: 'off', enabled: false }],
        },
        { id: 'nokey', kind: 'openai', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'm2' }] },
      ]),
    },
    providersFile: path.join(dir, 'providers.json'),
  });
  const ctx = {
    db,
    providers,
    config: { memoryModel: envFallback },
    builtinConfig: { securityProfile: 'local', allowLocalBypass: true, allowServerBypass: false },
    audit: undefined,
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerConfigRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, db, ctx };
}

async function patch(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('memory model setting', () => {
  it('prefers the settings value over the env fallback', async () => {
    const { db } = await setup('fake:env');
    expect(configuredMemoryModel((key) => db.getSetting(key), 'fake:env')).toBe('fake:env');
    db.setSetting('memory_model', 'fake:m1');
    expect(configuredMemoryModel((key) => db.getSetting(key), 'fake:env')).toBe('fake:m1');
    db.deleteSetting('memory_model');
    expect(configuredMemoryModel((key) => db.getSetting(key), 'fake:env')).toBe('fake:env');
    expect(configuredMemoryModel((key) => db.getSetting(key), null)).toBeNull();
  });

  it('persists a validated model and exposes it through /api/config', async () => {
    const { url, db } = await setup();
    const before = (await (await fetch(`${url}/api/config`)).json()) as { memoryModel: string | null };
    expect(before.memoryModel).toBeNull();

    const response = await patch(url, { memoryModel: 'fake:m1' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { config: { memoryModel: string | null } };
    expect(body.config.memoryModel).toBe('fake:m1');
    expect(db.getSetting('memory_model')).toBe('fake:m1');
  });

  it('rejects unknown providers/models, disabled models and missing keys', async () => {
    const { url } = await setup();
    for (const value of ['missing:m1', 'fake:missing', 'fake:off', 'nokey:m2', 'no-colon']) {
      const response = await patch(url, { memoryModel: value });
      expect(response.status, value).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('invalid_memory_model');
    }
  });


  it('rejects malformed model ids without crashing the server', async () => {
    const { url } = await setup();
    for (const value of ['bad id:model', ':model', 'fake: model']) {
      const response = await patch(url, { memoryModel: value });
      expect(response.status, value).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('invalid_memory_model');
    }

    const stillAlive = await fetch(`${url}/api/config`);
    expect(stillAlive.status).toBe(200);
  });

  it('validates the whole patch before writing any setting', async () => {
    const { url, db } = await setup();
    db.setSetting(SETTING_DEFAULT_PERMISSION_MODE, 'ask');

    const response = await patch(url, {
      defaultPermissionMode: 'acceptEdits',
      memoryModel: 'bad id:model',
    });
    expect(response.status).toBe(400);
    expect(db.getSetting(SETTING_DEFAULT_PERMISSION_MODE)).toBe('ask');
  });
  it('clears the setting and falls back to the env value', async () => {
    const { url, db } = await setup('fake:m1');
    expect(((await (await fetch(`${url}/api/config`)).json()) as { memoryModel: string }).memoryModel).toBe('fake:m1');

    const response = await patch(url, { memoryModel: 'fake:m1' });
    expect(response.status).toBe(200);
    expect(db.getSetting('memory_model')).toBe('fake:m1');

    const cleared = await patch(url, { memoryModel: null });
    expect(cleared.status).toBe(200);
    expect(db.getSetting('memory_model')).toBeNull();
    expect(
      ((await cleared.json()) as { config: { memoryModel: string | null } }).config.memoryModel,
    ).toBe('fake:m1');
  });
});
