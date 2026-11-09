import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { MemoryStore } from '../src/memory/store';
import { registerMemoryRoutes } from '../src/routes/memory';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  dirs.push(dir);
  return dir;
}

async function setup() {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace } = db.ensureLifeWorkspace(tmpDir('life'));
  const source = store.insertSource({
    scope: `workspace:${workspace.id}`,
    endId: null,
    kind: 'note',
    sourceTable: 'note',
    occurredAt: Date.now(),
    content: '我住在上海',
  }).source;
  const claim = store.insertClaim(
    {
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '住在上海',
      confidence: 0.8,
      importance: 0.8,
    },
    [{ sourceId: source.id, quote: '我住在上海' }],
  );

  const ctx = { db, memory: store } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerMemoryRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    db,
    store,
    workspace,
    claim,
  };
}

describe('life -> user promotion', () => {
  it('creates a user claim with promoted_from and copies evidence', async () => {
    const { url, store, workspace, claim } = await setup();
    const response = await fetch(
      `${url}/api/memory/claims/${claim.id}/promote?scope=workspace:${workspace.id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shareClass: 'personal' }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      claim: { id: string; scope: string; promotedFrom: string; shareClass: string };
    };
    expect(body.claim).toMatchObject({
      scope: 'user',
      promotedFrom: claim.id,
      shareClass: 'personal',
    });
    expect(store.getClaim(claim.id)).toBeDefined();
    expect(store.claimEvidence(body.claim.id)).toHaveLength(1);

    const userClaims = (await (await fetch(`${url}/api/memory/claims?scope=user`)).json()) as {
      claims: { id: string }[];
    };
    expect(userClaims.claims.map((item) => item.id)).toContain(body.claim.id);
  });

  it('rejects promotion from a dev workspace', async () => {
    const { url, db, store } = await setup();
    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag')!;
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    const devClaim = store.insertClaim({
      scope: `workspace:${dev.id}`,
      endId: null,
      predicate: 'uses_framework',
      objectText: 'Compose',
      kind: 'fact',
      summary: '使用 Compose',
      confidence: 0.8,
      importance: 0.8,
    });
    const response = await fetch(
      `${url}/api/memory/claims/${devClaim.id}/promote?scope=workspace:${dev.id}`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('promotion_not_supported');
  });
});
