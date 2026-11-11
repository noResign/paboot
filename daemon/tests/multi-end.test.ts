import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import {
  enabledCapabilityServers,
  resolveCapabilityTargetEnd,
  resolvePrimaryEnd,
  resolveSessionEnds,
} from '../src/capabilities/scope';
import { Db } from '../src/db/db';
import { KnowledgeStore } from '../src/knowledge/store';
import { endsContext } from '../src/runs/end-context';
import { registerEndRoutes } from '../src/routes/ends';
import { registerSessionRoutes } from '../src/routes/sessions';

const dbs: Db[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-multi-end-${name}-`));
  dirs.push(dir);
  return dir;
}

async function boot() {
  const dataDir = tmpDir('data');
  const root = tmpDir('repo');
  const db = new Db(':memory:');
  dbs.push(db);
  const workspace = db.createWorkspace({ name: 'demo', path: root, family: 'dev' });
  const session = db.createSession({
    id: 's-main',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: root,
  });
  const knowledge = new KnowledgeStore(dataDir);
  const ctx = { db, knowledge, config: { dataDir } } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    (res.locals as { authRole?: string }).authRole = 'operator';
    next();
  });
  registerEndRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { db, knowledge, workspace, session, root, ctx, url: `http://127.0.0.1:${port}` };
}

async function createEnd(
  url: string,
  workspaceId: string,
  input: { name: string; kind?: string },
): Promise<{ id: string }> {
  const res = await fetch(`${url}/api/workspaces/${workspaceId}/ends`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { end?: { id: string }; error?: string };
  if (!res.ok || !body.end) {
    throw new Error(`create end failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.end;
}

async function bindRoot(url: string, workspaceId: string, endId: string, dir: string): Promise<void> {
  const res = await fetch(`${url}/api/workspaces/${workspaceId}/ends/${endId}/roots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  expect(res.status).toBe(200);
}

describe('multi-end session scope', () => {
  it('uses every active end and narrows via session_ends', async () => {
    const { db, workspace, session, root } = await boot();
    const android = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Android',
      status: 'active',
    });
    const ios = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'ios',
      name: 'iOS',
      status: 'active',
    });
    db.addEndRoot(android.id, path.join(root, 'android'));
    expect(resolveSessionEnds(db, session).map((end) => end.id)).toEqual([android.id, ios.id]);
    expect(resolvePrimaryEnd(db, session)?.id).toBe(android.id);

    db.replaceSessionEnds(session.id, [ios.id]);
    expect(resolveSessionEnds(db, session).map((end) => end.id)).toEqual([ios.id]);
    expect(resolvePrimaryEnd(db, session)?.id).toBe(ios.id);

    db.clearSessionEnds(session.id);
    expect(resolveSessionEnds(db, session)).toHaveLength(2);
    expect(workspace.id).toBeTruthy();
  });

  it('routes same-kind capabilities by cwd, endId, or reports ambiguity', async () => {
    const { db, workspace } = await boot();
    const appPath = tmpDir('app');
    const libPath = tmpDir('lib');
    const one = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'App',
      status: 'active',
    });
    const two = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Lib',
      status: 'active',
    });
    for (const [end, dir] of [
      [one, appPath],
      [two, libPath],
    ] as const) {
      db.addEndRoot(end.id, dir);
      db.upsertCapabilityBinding({
        scopeType: 'end',
        scopeId: end.id,
        providerId: 'android-device',
        enabled: true,
      });
    }
    const appSession = db.createSession({
      id: 's-app',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: appPath,
    });
    const libSession = db.createSession({
      id: 's-lib',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: libPath,
    });
    const outside = db.createSession({
      id: 's-outside',
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: tmpDir('elsewhere'),
    });

    expect(resolveCapabilityTargetEnd(db, appSession, 'android-device', undefined).end?.id).toBe(one.id);
    expect(resolveCapabilityTargetEnd(db, libSession, 'android-device', undefined).end?.id).toBe(two.id);
    expect(resolveCapabilityTargetEnd(db, outside, 'android-device', undefined).code).toBe('end_ambiguous');
    expect(resolveCapabilityTargetEnd(db, outside, 'android-device', one.id).end?.id).toBe(one.id);
    expect(resolveCapabilityTargetEnd(db, outside, 'android-device', 'missing').code).toBe('end_not_allowed');

    db.upsertCapabilityBinding({
      scopeType: 'end',
      scopeId: two.id,
      providerId: 'android-device',
      enabled: false,
    });
    // Only one candidate left, so it is used without an explicit endId.
    expect(resolveCapabilityTargetEnd(db, libSession, 'android-device', undefined).end?.id).toBe(one.id);
    db.upsertCapabilityBinding({
      scopeType: 'end',
      scopeId: one.id,
      providerId: 'android-device',
      enabled: false,
    });
    expect(resolveCapabilityTargetEnd(db, libSession, 'android-device', undefined).code).toBe('end_missing');
  });
});

describe('end lifecycle and session ends routes', () => {
  it('patches text, toggles capabilities and seeds domain conventions on activation', async () => {
    const { db, knowledge, workspace, url, root } = await boot();
    const end = await createEnd(url, workspace.id, { name: 'App', kind: 'android' });
    await bindRoot(url, workspace.id, end.id, root);

    const activated = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends/${end.id}/activate`, { method: 'POST' })
    ).json()) as { end: { capabilities: Array<{ id: string; enabled: boolean }> } };
    expect(activated.end.capabilities.map((capability) => capability.id).sort()).toEqual([
      'android-device',
      'mock',
    ]);
    expect(
      activated.end.capabilities.find((capability) => capability.id === 'android-device')?.enabled,
    ).toBe(true);

    const seeded = knowledge.list(workspace.id, { kind: 'convention', endId: end.id });
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.title).toBe('Android 约定');

    const patched = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends/${end.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: '主 App', notes: '不要改 versionCode 规则' }),
      })
    ).json()) as { end: { summary: string; notes: string } };
    expect(patched.end.summary).toBe('主 App');
    expect(patched.end.notes).toContain('versionCode');

    const disabled = (await (
      await fetch(`${url}/api/workspaces/${workspace.id}/ends/${end.id}/capabilities`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: [] }),
      })
    ).json()) as { end: { capabilities: Array<{ id: string; enabled: boolean }> } };
    expect(disabled.end.capabilities[0]?.enabled).toBe(false);
    expect(db.listSessionEnds('s-main')).toHaveLength(0);

    const bad = await fetch(`${url}/api/workspaces/${workspace.id}/ends/${end.id}/capabilities`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: ['not-a-capability'] }),
    });
    expect(bad.status).toBe(400);
  });

  it('moves end knowledge aside on archive and restores its kind', async () => {
    const { knowledge, workspace, url, root } = await boot();
    const end = await createEnd(url, workspace.id, { name: 'App', kind: 'android' });
    await bindRoot(url, workspace.id, end.id, root);
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${end.id}/activate`, { method: 'POST' });
    expect(knowledge.list(workspace.id, { kind: 'convention', endId: end.id })).toHaveLength(1);

    const archived = await fetch(
      `${url}/api/workspaces/${workspace.id}/ends/${end.id}/archive`,
      { method: 'POST' },
    );
    expect(archived.status).toBe(200);
    expect(knowledge.list(workspace.id, { kind: 'convention', endId: end.id })).toHaveLength(0);

    const restored = await fetch(
      `${url}/api/workspaces/${workspace.id}/ends/${end.id}/restore`,
      { method: 'POST' },
    );
    expect(restored.status).toBe(200);
    const docs = knowledge.list(workspace.id, { kind: 'convention', endId: end.id });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.kind).toBe('convention');
  });

  it('exposes and narrows the session end set over HTTP', async () => {
    const { db, workspace, url, root } = await boot();
    const android = await createEnd(url, workspace.id, { name: 'Android' });
    const ios = await createEnd(url, workspace.id, { name: 'iOS', kind: 'ios' });
    await bindRoot(url, workspace.id, android.id, root);
    await bindRoot(url, workspace.id, ios.id, root);
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${android.id}/activate`, { method: 'POST' });
    await fetch(`${url}/api/workspaces/${workspace.id}/ends/${ios.id}/activate`, { method: 'POST' });

    const initial = (await (
      await fetch(`${url}/api/sessions/s-main/ends`)
    ).json()) as { primaryEndId: string | null; ends: Array<{ id: string; role: string }> };
    expect(initial.ends.map((end) => end.id).sort()).toEqual([android.id, ios.id].sort());
    expect(initial.primaryEndId).toBe(android.id);

    const narrowed = (await (
      await fetch(`${url}/api/sessions/s-main/ends`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endIds: [ios.id] }),
      })
    ).json()) as { primaryEndId: string | null; ends: Array<{ id: string }> };
    expect(narrowed.ends.map((end) => end.id)).toEqual([ios.id]);
    expect(narrowed.primaryEndId).toBe(ios.id);
    expect(enabledCapabilityServers(db, db.getSession('s-main')!).size).toBe(0);

    const invalid = await fetch(`${url}/api/sessions/s-main/ends`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endIds: ['nope'] }),
    });
    expect(invalid.status).toBe(400);

    const reset = (await (
      await fetch(`${url}/api/sessions/s-main/ends`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endIds: [] }),
      })
    ).json()) as { ends: Array<{ id: string }> };
    expect(reset.ends).toHaveLength(2);
  });

  it('builds a compact end context from the primary and index ends', async () => {
    const { db, workspace, session, ctx } = await boot();
    const android = db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'android',
      name: 'Android',
      status: 'active',
    });
    db.updateEnd(android.id, { summary: '主 App', notes: '构建前先 ./gradlew clean' });
    db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind: 'ios',
      name: 'iOS',
      status: 'active',
    });
    const prelude = endsContext(ctx, session, workspace);
    expect(prelude?.prefix).toContain('## End: Android');
    expect(prelude?.prefix).toContain('构建前先 ./gradlew clean');
    expect(prelude?.prefix).toContain('## Ends');
    expect(prelude?.prefix).toContain('iOS');
  });
});
