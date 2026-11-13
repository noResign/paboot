import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db, type SessionRow, type WorkspaceRow } from '../src/db/db';
import { MemoryStore } from '../src/memory/store';
import { captureRunMessages } from '../src/memory/ingest';
import { registerMemoryRoutes } from '../src/routes/memory';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

async function setup(): Promise<{
  url: string;
  db: Db;
  store: MemoryStore;
  workspace: WorkspaceRow;
  endId: string;
  session: SessionRow;
  ctx: AppContext;
}> {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace, end } = db.ensureLifeWorkspace(tmpDir('life'));
  const session = db.createSession({
    id: 's-life',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  db.addMessage(session.id, 'user', '我搬到上海了');

  const ctx = {
    db,
    memory: store,
    providers: {
      list: async () => [
        {
          id: 'fake',
          hasApiKey: true,
          models: [{ id: 'fake-1' }, { id: 'from-settings' }],
        },
      ],
    },
    config: { memoryModel: 'fake:fake-1' },
  } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  registerMemoryRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, db, store, workspace, endId: end.id, session, ctx };
}

function claimIn(
  store: MemoryStore,
  workspaceId: string,
  endId: string | null,
  summary = '住在上海',
) {
  return store.insertClaim({
    scope: `workspace:${workspaceId}`,
    endId,
    predicate: 'lives_in',
    objectText: '上海',
    kind: 'fact',
    summary,
    confidence: 0.8,
    importance: 0.8,
  });
}

describe('memory routes (M0)', () => {
  it('returns the brief and claim list for a life session', async () => {
    const { url, store, workspace, endId, session } = await setup();
    claimIn(store, workspace.id, endId);

    const brief = await fetch(`${url}/api/memory/brief?sessionId=${session.id}`);
    expect(brief.status).toBe(200);
    expect((await brief.json()) as { markdown: string }).toMatchObject({
      markdown: expect.stringContaining('住在上海'),
    });

    const claims = await fetch(`${url}/api/memory/claims?sessionId=${session.id}`);
    expect(claims.status).toBe(200);
    const body = (await claims.json()) as { claims: { id: string; evidence: unknown[] }[] };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]?.evidence).toEqual([]);
  });

  it('requires a scope and rejects a disabled dev workspace', async () => {
    const { url, db } = await setup();
    const missing = await fetch(`${url}/api/memory/claims`);
    expect(missing.status).toBe(400);

    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag');
    const rejected = await fetch(`${url}/api/memory/claims?scope=workspace:${dev!.id}`);
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe('memory_not_enabled');
  });

  it('exposes effective settings and validates family-specific fields', async () => {
    const { url, db, workspace } = await setup();
    const life = (await (await fetch(`${url}/api/workspaces/${workspace.id}/memory`)).json()) as {
      enabled: boolean;
      profileMode?: string;
      lifeReadable?: boolean;
    };
    expect(life).toMatchObject({ enabled: true, profileMode: 'portable' });
    expect(life.lifeReadable).toBeUndefined();

    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag')!;
    const devDefaults = (await (await fetch(`${url}/api/workspaces/${dev.id}/memory`)).json()) as {
      enabled: boolean;
      lifeReadable?: boolean;
      profileMode?: string;
    };
    expect(devDefaults).toMatchObject({ enabled: false, lifeReadable: false });
    expect(devDefaults.profileMode).toBeUndefined();

    const patched = await fetch(`${url}/api/workspaces/${dev.id}/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, lifeReadable: true, providerOverride: 'work' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      enabled: true,
      lifeReadable: true,
      providerOverride: 'work',
    });

    const wrongDev = await fetch(`${url}/api/workspaces/${dev.id}/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileMode: 'full' }),
    });
    expect(wrongDev.status).toBe(400);
    const wrongLife = await fetch(`${url}/api/workspaces/${workspace.id}/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lifeReadable: true }),
    });
    expect(wrongLife.status).toBe(400);
  });

  it('reads an enabled dev workspace and keeps it isolated from life', async () => {
    const { url, db, store, workspace, endId, session } = await setup();
    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag')!;
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    db.updateWorkspaceMemory(dev.id, { lifeReadable: true });
    const lifeClaim = claimIn(store, workspace.id, endId, '个人空间里的上海');
    const devClaim = store.insertClaim({
      scope: `workspace:${dev.id}`,
      endId: null,
      predicate: 'uses_framework',
      objectText: 'Compose',
      kind: 'fact',
      summary: '项目使用 Compose',
      confidence: 0.8,
      importance: 0.8,
    });
    const devSession = db.createSession({
      id: 's-dev',
      runtime: 'claude',
      workspaceId: dev.id,
      permissionMode: 'ask',
      cwd: dev.path,
    });

    const devClaims = (await (await fetch(`${url}/api/memory/claims?sessionId=${devSession.id}`)).json()) as {
      claims: { id: string }[];
    };
    expect(devClaims.claims.map((claim) => claim.id)).toEqual([devClaim.id]);

    // Dev cannot reach life even though it has a readable policy of its own.
    expect(devClaims.claims.some((claim) => claim.id === lifeClaim.id)).toBe(false);

    // And the life session sees both (the dev workspace is life_readable).
    const lifeClaims = (await (await fetch(`${url}/api/memory/claims?sessionId=${session.id}`)).json()) as {
      claims: { id: string }[];
    };
    expect(lifeClaims.claims.map((claim) => claim.id).sort()).toEqual(
      [devClaim.id, lifeClaim.id].sort(),
    );
  });

  it('lets life read normal claims from a life_readable dev workspace only', async () => {
    const { url, db, store, workspace, endId, session } = await setup();
    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag')!;
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    db.updateWorkspaceMemory(dev.id, { lifeReadable: true });
    const normal = store.insertClaim({
      scope: `workspace:${dev.id}`,
      endId: null,
      predicate: 'uses_database',
      objectText: 'Postgres',
      kind: 'fact',
      summary: '项目使用 Postgres',
      confidence: 0.8,
      importance: 0.8,
    });
    const privateClaim = store.insertClaim({
      scope: `workspace:${dev.id}`,
      endId: null,
      predicate: 'client_secret',
      objectText: 'hidden',
      kind: 'fact',
      summary: '私密客户信息',
      sensitivity: 'private',
      confidence: 0.8,
      importance: 0.8,
    });

    const claims = (await (await fetch(`${url}/api/memory/claims?sessionId=${session.id}`)).json()) as {
      claims: { id: string }[];
    };
    expect(claims.claims.map((claim) => claim.id)).toEqual([normal.id]);
    expect(claims.claims.some((claim) => claim.id === privateClaim.id)).toBe(false);

    // Cross-read claims are read-only.
    const patch = await fetch(`${url}/api/memory/claims/${normal.id}?sessionId=${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectText: 'changed' }),
    });
    expect(patch.status).toBe(404);
    expect(claimIn(store, workspace.id, endId)).toBeTruthy();
  });

  it('saves the per-session switch even when the workspace has memory disabled', async () => {
    const { url, db } = await setup();
    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag')!;
    const devSession = db.createSession({
      id: 's-dev-memory',
      runtime: 'claude',
      workspaceId: dev.id,
      permissionMode: 'ask',
      cwd: dev.path,
    });
    const response = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: devSession.id, mode: 'off' }),
    });
    expect(response.status).toBe(200);
    expect(db.getSession(devSession.id)?.memory_mode).toBe('off');

    const command = db.createSession({
      id: 's-command',
      runtime: 'command',
      workspaceId: dev.id,
      permissionMode: 'ask',
      cwd: dev.path,
      kind: 'command',
    });
    const rejected = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: command.id, mode: 'off' }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe('session_not_chat');
  });

  it('supports internal remember / forget / complete-loop by run id', async () => {
    const { url, db, store, workspace, session } = await setup();
    db.createRun({
      id: 'run-internal',
      sessionId: session.id,
      runtime: 'claude',
      model: null,
      prompt: 'x',
      status: 'running',
      permissionMode: 'ask',
    });
    const remembered = await fetch(
      `${url}/api/internal/memory/remember?runId=run-internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '记住我喜欢咖啡' }),
      },
    );
    expect(remembered.status).toBe(200);
    expect(store.listSources(`workspace:${workspace.id}`).some((source) => source.content.includes('咖啡')))
      .toBe(true);

    const claim = claimIn(store, workspace.id, null, '喜欢咖啡');
    const forgotten = await fetch(`${url}/api/internal/memory/forget?runId=run-internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimId: claim.id }),
    });
    expect(forgotten.status).toBe(200);
    expect(store.getClaim(claim.id)).toBeUndefined();

    const loop = store.upsertLoopCandidate({
      scope: `workspace:${workspace.id}`,
      endId: null,
      title: '补测试',
    });
    const completed = await fetch(
      `${url}/api/internal/memory/loops/${loop}/complete?runId=run-internal`,
      { method: 'POST' },
    );
    expect(completed.status).toBe(200);
    expect(store.listOpenLoops(`workspace:${workspace.id}`)).toEqual([]);
  });

  it('lists open loops for the session scope', async () => {
    const { url, store, workspace, session } = await setup();
    store.upsertLoopCandidate({
      scope: `workspace:${workspace.id}`,
      endId: null,
      title: '补集成测试',
    });
    const response = await fetch(`${url}/api/memory/loops?sessionId=${session.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { loops: { title: string }[] };
    expect(body.loops.map((loop) => loop.title)).toContain('补集成测试');
  });

  it('lists loops by status and lets an operator confirm or reopen a candidate', async () => {
    const { url, store, workspace, session } = await setup();
    const scope = `workspace:${workspace.id}` as const;
    const loopId = store.upsertLoopCandidate({ scope, endId: null, title: '补集成测试' });
    store.markLoopCandidateDone(scope, loopId, 'completed: 补完集成测试');

    // Default listing stays "open only" so `[未完成]` recall is unaffected.
    const openOnly = (await (
      await fetch(`${url}/api/memory/loops?sessionId=${session.id}`)
    ).json()) as { loops: unknown[] };
    expect(openOnly.loops).toHaveLength(0);

    const candidates = (await (
      await fetch(`${url}/api/memory/loops?sessionId=${session.id}&status=candidate_done`)
    ).json()) as { loops: { title: string; status: string }[] };
    expect(candidates.loops).toMatchObject([{ title: '补集成测试', status: 'candidate_done' }]);

    const reopen = await fetch(`${url}/api/memory/loops/${loopId}?sessionId=${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reopen' }),
    });
    expect(reopen.status).toBe(200);
    expect(store.listOpenLoops(scope)).toHaveLength(1);

    store.markLoopCandidateDone(scope, loopId, 'completed again');
    const confirm = await fetch(`${url}/api/memory/loops/${loopId}?sessionId=${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm' }),
    });
    expect(confirm.status).toBe(200);
    expect(store.listLoops(scope, 'candidate_done')).toHaveLength(0);
  });

  it('lists and resolves duplicate candidates', async () => {
    const { url, store, workspace, session } = await setup();
    for (let index = 0; index < 20; index += 1) {
      store.insertClaim({
        scope: `workspace:${workspace.id}`,
        endId: null,
        predicate: `filler_${index}`,
        objectText: `填充 ${index}`,
        kind: 'fact',
        summary: `无关记录 ${index}`,
        confidence: 0.8,
        importance: 0.8,
      });
    }
    const target = store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'likes',
      objectText: '手冲咖啡',
      kind: 'preference',
      summary: '喜欢手冲咖啡',
      confidence: 0.8,
      importance: 0.8,
    });
    store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'likes',
      objectText: '手冲黑咖啡',
      kind: 'preference',
      summary: '喜欢手冲咖啡',
      confidence: 0.8,
      importance: 0.8,
    });

    const list = await fetch(`${url}/api/memory/duplicates?sessionId=${session.id}`);
    const body = (await list.json()) as {
      duplicates: { id: string; duplicateOf: string }[];
    };
    expect(body.duplicates).toHaveLength(1);
    expect(body.duplicates[0]?.duplicateOf).toBe(target.id);

    const merged = await fetch(
      `${url}/api/memory/duplicates/${body.duplicates[0]!.id}?sessionId=${session.id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'merge' }),
      },
    );
    expect(merged.status).toBe(200);
    const after = (await (
      await fetch(`${url}/api/memory/duplicates?sessionId=${session.id}`)
    ).json()) as { duplicates: unknown[] };
    expect(after.duplicates).toHaveLength(0);
  });

  it('corrects a claim and marks it user_confirmed', async () => {
    const { url, store, workspace, endId, session } = await setup();
    const claim = claimIn(store, workspace.id, endId);

    const response = await fetch(`${url}/api/memory/claims/${claim.id}?sessionId=${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectText: '杭州' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claim: { authority: string; confidence: number; objectText: string } };
    expect(body.claim).toMatchObject({ authority: 'user_confirmed', confidence: 1, objectText: '杭州' });
  });

  it('does not expose a claim from another scope', async () => {
    const { url, store, endId, session } = await setup();
    const other = claimIn(store, 'another-workspace', endId);
    const response = await fetch(`${url}/api/memory/claims/${other.id}?sessionId=${session.id}`);
    expect(response.status).toBe(404);
  });

  it('never exposes secret claims through the claims API', async () => {
    const { url, store, workspace, endId, session } = await setup();
    const secret = store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId,
      predicate: 'profile',
      objectText: '银行卡密码',
      kind: 'profile',
      summary: '银行卡密码是 123456',
      sensitivity: 'secret',
      confidence: 1,
      importance: 1,
    });

    const list = await fetch(`${url}/api/memory/claims?sessionId=${session.id}`);
    expect(((await list.json()) as { claims: unknown[] }).claims).toEqual([]);
    const detail = await fetch(`${url}/api/memory/claims/${secret.id}?sessionId=${session.id}`);
    expect(detail.status).toBe(404);
  });

  it('forgets a claim and tombstones its evidence', async () => {
    const { url, db, store, workspace, endId, session } = await setup();
    const source = store.insertSource({
      scope: `workspace:${workspace.id}`,
      workspaceId: workspace.id,
      endId,
      kind: 'message',
      sourceTable: 'messages',
      sessionId: session.id,
      messageId: 1,
      occurredAt: Date.now(),
      content: '我搬到上海了',
    }).source;
    const claim = store.insertClaim(
      {
        scope: `workspace:${workspace.id}`,
        endId,
        predicate: 'lives_in',
        objectText: '上海',
        kind: 'fact',
        summary: '住在上海',
        confidence: 0.8,
        importance: 0.8,
      },
      [{ sourceId: source.id, quote: '我搬到上海了' }],
    );

    const response = await fetch(`${url}/api/memory/claims/${claim.id}?sessionId=${session.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(store.getClaim(claim.id)).toBeUndefined();
    expect(store.hasTombstone(`workspace:${workspace.id}`, endId, source.contentHash)).toBe(true);

    const messageId = db.listMessages(session.id)[0]!.id;
    const remembered = await fetch(`${url}/api/memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, messageId }),
    });
    expect(remembered.status).toBe(409);
    expect(((await remembered.json()) as { code: string }).code).toBe('forgotten_content');
  });

  it('remembers a message and reports status', async () => {
    const { url, db, store, workspace, session } = await setup();
    const messageId = db.listMessages(session.id)[0]!.id;

    const response = await fetch(`${url}/api/memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, messageId }),
    });
    expect(response.status).toBe(200);
    expect(store.countSources('pending', `workspace:${workspace.id}`)).toBe(1);

    const status = await fetch(`${url}/api/memory/status?sessionId=${session.id}`);
    expect(status.status).toBe(200);
    expect((await status.json()) as {
      pendingSources: number;
      extractionModel: string;
      modelAvailable: boolean;
    }).toMatchObject({
      pendingSources: 1,
      extractionModel: 'fake:fake-1',
      modelAvailable: true,
    });

    // The settings-table pick wins over the env fallback shown in ctx.config.
    db.setSetting('memory_model', 'fake:from-settings');
    const updated = (await (
      await fetch(`${url}/api/memory/status?sessionId=${session.id}`)
    ).json()) as { extractionModel: string; modelAvailable: boolean };
    expect(updated.extractionModel).toBe('fake:from-settings');
    expect(updated.modelAvailable).toBe(true);
  });

  it('does not backfill messages sent while memory was off', async () => {
    const { url, db, store, workspace, session } = await setup();

    const off = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, mode: 'off' }),
    });
    expect(off.status).toBe(200);
    db.addMessage(session.id, 'user', '关闭记忆期间说的话');

    const on = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, mode: 'normal' }),
    });
    expect(on.status).toBe(200);
    db.addMessage(session.id, 'user', '重新开启后说的话');

    const current = db.getSession(session.id) as SessionRow;
    const captured = captureRunMessages({
      store,
      session: current,
      workspace,
      ends: db.listEnds(workspace.id),
      messages: db.listMessages(session.id),
      runId: 'r-after-memory-on',
    });
    expect(captured).toBe(1);
    expect(store.listSources(`workspace:${workspace.id}`).map((item) => item.content)).toEqual([
      '重新开启后说的话',
    ]);
  });

  it('switches a session memory mode', async () => {
    const { url, db, session } = await setup();
    const response = await fetch(`${url}/api/memory/session`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, mode: 'off' }),
    });
    expect(response.status).toBe(200);
    expect(db.getSession(session.id)?.memory_mode).toBe('off');
  });
});

describe('memory entity routes', () => {
  function merge(
    url: string,
    sessionId: string,
    id: string,
    mergeInto: string,
  ): Promise<Response> {
    return fetch(`${url}/api/memory/entities/${id}?sessionId=${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mergeInto }),
    });
  }

  it('lists active entities with claim counts', async () => {
    const { url, store, workspace, session } = await setup();
    const scope = `workspace:${workspace.id}`;
    const person = store.upsertEntity({ scope, kind: 'person', name: '张女士' });
    store.insertClaim({
      scope,
      entityId: person.id,
      predicate: 'lives_in',
      kind: 'fact',
      summary: '住在上海',
      confidence: 0.8,
      importance: 0.8,
    });

    const response = await fetch(`${url}/api/memory/entities?sessionId=${session.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entities: { id: string; canonicalName: string; claimCount: number }[];
    };
    expect(body.entities).toEqual([
      expect.objectContaining({ id: person.id, canonicalName: '张女士', claimCount: 1 }),
    ]);
  });

  it('merges same-kind entities in the same scope', async () => {
    const { url, store, workspace, session } = await setup();
    const scope = `workspace:${workspace.id}`;
    const source = store.upsertEntity({
      scope,
      kind: 'person',
      name: '张阿姨',
      aliases: ['阿姨'],
    });
    const target = store.upsertEntity({ scope, kind: 'person', name: '张女士' });
    const claim = store.insertClaim({
      scope,
      entityId: source.id,
      predicate: 'lives_in',
      kind: 'fact',
      summary: '张阿姨住在上海',
      confidence: 0.8,
      importance: 0.8,
    });

    const response = await merge(url, session.id, source.id, target.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      entity: { id: string; aliases: string[]; claimCount: number };
    };
    expect(body.ok).toBe(true);
    expect(body.entity.id).toBe(target.id);
    expect(body.entity.aliases).toContain('张阿姨');
    expect(body.entity.claimCount).toBe(1);
    expect(store.getClaim(claim.id)?.entityId).toBe(target.id);

    const list = (await (
      await fetch(`${url}/api/memory/entities?sessionId=${session.id}`)
    ).json()) as { entities: { id: string }[] };
    expect(list.entities.map((entity) => entity.id)).toEqual([target.id]);
  });

  it('lists merged entities and unmerges them', async () => {
    const { url, store, workspace, session } = await setup();
    const scope = `workspace:${workspace.id}`;
    const source = store.upsertEntity({ scope, kind: 'person', name: '张阿姨' });
    const target = store.upsertEntity({ scope, kind: 'person', name: '张女士' });
    const claim = store.insertClaim({
      scope,
      entityId: source.id,
      predicate: 'lives_in',
      kind: 'fact',
      summary: '张阿姨住在上海',
      confidence: 0.8,
      importance: 0.8,
    });
    expect((await merge(url, session.id, source.id, target.id)).status).toBe(200);

    const mergedList = (await (
      await fetch(`${url}/api/memory/entities?sessionId=${session.id}&status=merged`)
    ).json()) as {
      entities: { id: string; status: string; mergedIntoName: string | null }[];
    };
    expect(mergedList.entities).toEqual([
      expect.objectContaining({
        id: source.id,
        status: 'merged',
        mergedIntoName: '张女士',
      }),
    ]);

    const unmerged = await fetch(
      `${url}/api/memory/entities/${source.id}/unmerge?sessionId=${session.id}`,
      { method: 'POST' },
    );
    expect(unmerged.status).toBe(200);
    const body = (await unmerged.json()) as { entity: { id: string; status: string } };
    expect(body.entity).toMatchObject({ id: source.id, status: 'active' });
    expect(store.getClaim(claim.id)?.entityId).toBe(source.id);

    const again = await fetch(
      `${url}/api/memory/entities/${source.id}/unmerge?sessionId=${session.id}`,
      { method: 'POST' },
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('source_not_merged');

    const invalid = await fetch(
      `${url}/api/memory/entities?sessionId=${session.id}&status=archived`,
    );
    expect(invalid.status).toBe(400);
  });

  it('rejects invalid entity merges', async () => {
    const { url, store, workspace, session } = await setup();
    const scope = `workspace:${workspace.id}`;
    const source = store.upsertEntity({ scope, kind: 'person', name: '张阿姨' });
    const target = store.upsertEntity({ scope, kind: 'person', name: '张女士' });
    const place = store.upsertEntity({ scope, kind: 'place', name: '上海' });
    const otherScope = store.upsertEntity({
      scope: 'workspace:other',
      kind: 'person',
      name: '张女士',
    });

    const self = await merge(url, session.id, source.id, source.id);
    expect(self.status).toBe(400);
    expect(((await self.json()) as { code: string }).code).toBe('entity_same');

    const kindMismatch = await merge(url, session.id, source.id, place.id);
    expect(kindMismatch.status).toBe(409);
    expect(((await kindMismatch.json()) as { code: string }).code).toBe(
      'entity_kind_mismatch',
    );

    const crossScope = await merge(url, session.id, source.id, otherScope.id);
    expect(crossScope.status).toBe(404);

    const missing = await merge(url, session.id, source.id, 'missing-entity');
    expect(missing.status).toBe(404);

    expect((await merge(url, session.id, source.id, target.id)).status).toBe(200);
    const again = await merge(url, session.id, source.id, target.id);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('entity_merged');
  });
});

describe('memory dispute routes', () => {
  it('lists and resolves disputed claims', async () => {
    const { url, store, workspace, session } = await setup();
    const scope = `workspace:${workspace.id}`;
    const old = store.insertClaim({
      scope,
      endId: null,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '住在上海',
      authority: 'user_confirmed',
      validFrom: 1_000,
      confidence: 1,
      importance: 0.9,
    });
    const incoming = store.insertClaim({
      scope,
      endId: null,
      predicate: 'lives_in',
      objectText: '杭州',
      kind: 'fact',
      summary: '住在杭州',
      validFrom: 2_000,
      confidence: 0.8,
      importance: 0.8,
    });

    const list = (await (
      await fetch(`${url}/api/memory/disputes?sessionId=${session.id}`)
    ).json()) as {
      disputes: { id: string; predicate: string; newClaim: { id: string } }[];
    };
    expect(list.disputes).toEqual([
      expect.objectContaining({
        id: `${incoming.id}:${old.id}`,
        predicate: 'lives_in',
      }),
    ]);

    const resolved = await fetch(
      `${url}/api/memory/disputes/${incoming.id}/resolve?sessionId=${session.id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldId: old.id, keep: 'old' }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(store.getClaim(old.id)?.status).toBe('active');
    expect(store.getClaim(incoming.id)?.status).toBe('archived');

    const after = (await (
      await fetch(`${url}/api/memory/disputes?sessionId=${session.id}`)
    ).json()) as { disputes: unknown[] };
    expect(after.disputes).toHaveLength(0);

    const again = await fetch(
      `${url}/api/memory/disputes/${incoming.id}/resolve?sessionId=${session.id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldId: old.id, keep: 'new' }),
      },
    );
    expect(again.status).toBe(409);

    const invalid = await fetch(
      `${url}/api/memory/disputes/${incoming.id}/resolve?sessionId=${session.id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldId: old.id, keep: 'maybe' }),
      },
    );
    expect(invalid.status).toBe(400);

    const otherScope = (await (
      await fetch(`${url}/api/memory/disputes?scope=user`)
    ).json()) as { disputes: unknown[] };
    expect(otherScope.disputes).toHaveLength(0);
  });
});

describe('memory entity link routes', () => {
  it('links and unlinks personal-scope entities', async () => {
    const { url, store, workspace, session } = await setup();
    const life = store.upsertEntity({
      scope: `workspace:${workspace.id}`,
      kind: 'person',
      name: '张女士',
    });
    const user = store.upsertEntity({ scope: 'user', kind: 'person', name: '张女士' });
    const dev = store.upsertEntity({ scope: 'workspace:dev-a', kind: 'person', name: '张女士' });

    const created = await fetch(`${url}/api/memory/entity-links?sessionId=${session.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: user.id, b: life.id }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      ok: boolean;
      link: { relation: string; createdBy: string };
    };
    expect(body.ok).toBe(true);
    expect(body.link).toMatchObject({ relation: 'same_person', createdBy: 'operator' });

    const listed = (await (
      await fetch(`${url}/api/memory/entity-links?sessionId=${session.id}`)
    ).json()) as { links: { a: { id: string }; b: { id: string } }[] };
    expect(listed.links).toHaveLength(1);

    const devLink = await fetch(`${url}/api/memory/entity-links?sessionId=${session.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: dev.id, b: user.id }),
    });
    expect(devLink.status).toBe(409);
    expect(((await devLink.json()) as { code: string }).code).toBe('link_not_allowed');

    const deleted = await fetch(
      `${url}/api/memory/entity-links?sessionId=${session.id}&a=${user.id}&b=${life.id}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    const after = (await (
      await fetch(`${url}/api/memory/entity-links?sessionId=${session.id}`)
    ).json()) as { links: unknown[] };
    expect(after.links).toHaveLength(0);
  });
});
