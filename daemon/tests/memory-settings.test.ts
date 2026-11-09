import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db, type SessionRow, type WorkspaceRow } from '../src/db/db';
import { buildMemoryBrief } from '../src/memory/brief';
import { claimAllowed, resolveReadPolicy } from '../src/memory/read-policy';
import { resolveRunMemoryScope } from '../src/memory/scope-resolver';
import {
  effectiveMemorySettings,
  isMemoryEnabled,
  isMemoryInjectionEnabled,
} from '../src/memory/settings';
import { MemoryStore } from '../src/memory/store';
import type { MemoryClaim } from '../src/memory/types';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  dirs.push(dir);
  return dir;
}

function setup(): {
  db: Db;
  store: MemoryStore;
  life: WorkspaceRow;
  dev: WorkspaceRow;
} {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace: life } = db.ensureLifeWorkspace(tmpDir('life'));
  const dev = db.createWorkspace({
    name: 'repo',
    path: fs.realpathSync(tmpDir('repo')),
    isDefault: false,
  });
  return { db, store, life, dev };
}

function session(db: Db, workspace: WorkspaceRow): SessionRow {
  return db.createSession({
    id: `s-${Math.random().toString(16).slice(2)}`,
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
}

function claim(
  store: MemoryStore,
  scope: `workspace:${string}` | 'user',
  overrides: Partial<{ sensitivity: MemoryClaim['sensitivity']; shareClass: MemoryClaim['shareClass']; summary: string }> = {},
): MemoryClaim {
  return store.insertClaim({
    scope,
    predicate: 'lives_in',
    objectText: overrides.summary ?? '上海',
    kind: 'fact',
    summary: overrides.summary ?? '住在上海',
    sensitivity: overrides.sensitivity ?? 'normal',
    ...(scope === 'user' ? { shareClass: overrides.shareClass ?? 'portable' } : {}),
    confidence: 0.8,
    importance: 0.8,
  });
}

describe('workspace memory defaults', () => {
  it('is off for dev and on for life until a row exists', () => {
    const { db, life, dev } = setup();
    expect(effectiveMemorySettings(dev, undefined)).toMatchObject({
      enabled: false,
      injectionEnabled: true,
      lifeReadable: false,
    });
    expect(effectiveMemorySettings(life, undefined)).toMatchObject({
      enabled: true,
      injectionEnabled: true,
      profileMode: 'portable',
    });
    expect(isMemoryEnabled(dev, undefined)).toBe(false);
    expect(isMemoryEnabled(life, undefined)).toBe(true);
    expect(isMemoryInjectionEnabled(life, undefined)).toBe(true);
    expect(db.getMemorySettings(dev.id)).toBeUndefined();
  });

  it('persists resolved switches and profile/lifeReadable columns', () => {
    const { db, life, dev } = setup();
    db.putMemorySettings(dev.id, {
      enabled: true,
      injectionEnabled: false,
      providerOverride: 'work-provider',
    });
    db.updateWorkspaceMemory(dev.id, { lifeReadable: true });
    const reloadedDev = db.getWorkspace(dev.id)!;
    expect(effectiveMemorySettings(reloadedDev, db.getMemorySettings(dev.id))).toMatchObject({
      enabled: true,
      injectionEnabled: false,
      providerOverride: 'work-provider',
      lifeReadable: true,
    });

    db.updateWorkspaceMemory(life.id, { profileMode: 'full' });
    expect(effectiveMemorySettings(db.getWorkspace(life.id)!, undefined).profileMode).toBe('full');
  });
});

describe('capture scope follows the workspace switch', () => {
  it('captures a dev workspace only when enabled', () => {
    const { db, dev } = setup();
    const s = session(db, dev);
    const ends = db.listEnds(dev.id);
    expect(resolveRunMemoryScope(s, dev, ends)).toBeNull();
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    expect(
      resolveRunMemoryScope(
        s,
        db.getWorkspace(dev.id)!,
        ends,
        null,
        db.getMemorySettings(dev.id),
      ),
    ).toMatchObject({
      scope: `workspace:${dev.id}`,
      workspaceId: dev.id,
    });
  });

  it('stops capturing life when explicitly disabled', () => {
    const { db, life } = setup();
    const s = session(db, life);
    db.putMemorySettings(life.id, { enabled: false, injectionEnabled: true, providerOverride: null });
    expect(
      resolveRunMemoryScope(
        s,
        db.getWorkspace(life.id)!,
        db.listEnds(life.id),
        null,
        db.getMemorySettings(life.id),
      ),
    ).toBeNull();
  });
});

describe('memory read policy', () => {
  it('keeps dev to its own workspace', () => {
    const { db, dev } = setup();
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    const workspace = db.getWorkspace(dev.id)!;
    const policy = resolveReadPolicy({
      workspace,
      workspaces: db.listWorkspaces(),
      getSettings: (id) => db.getMemorySettings(id),
    });
    expect(policy.scopes).toEqual([
      { scope: `workspace:${dev.id}`, includePrivate: true },
    ]);
    expect(policy.includesUser).toBe(false);
  });

  it('lets life read user + life + only readable/enabled dev workspaces', () => {
    const { db, life, dev } = setup();
    const readable = db.createWorkspace({
      name: 'client',
      path: fs.realpathSync(tmpDir('client')),
      isDefault: false,
    });
    db.updateWorkspaceMemory(readable.id, { lifeReadable: true });
    db.putMemorySettings(readable.id, {
      enabled: true,
      injectionEnabled: true,
      providerOverride: null,
    });
    const hiddenReadable = db.createWorkspace({
      name: 'secret-client',
      path: fs.realpathSync(tmpDir('secret-client')),
      isDefault: false,
    });
    db.updateWorkspaceMemory(hiddenReadable.id, { lifeReadable: true });

    const policy = resolveReadPolicy({
      workspace: db.getWorkspace(life.id)!,
      workspaces: db.listWorkspaces(),
      getSettings: (id) => db.getMemorySettings(id),
    });
    expect(policy.scopes.map((item) => item.scope)).toEqual([
      'user',
      `workspace:${life.id}`,
      `workspace:${readable.id}`,
    ]);
    expect(policy.scopes.find((item) => item.scope === `workspace:${readable.id}`)?.includePrivate)
      .toBe(false);
    expect(policy.scopes.some((item) => item.scope === `workspace:${dev.id}`)).toBe(false);
  });

  it('filters cross-private, secret and profile share class', () => {
    const { db, store, life, dev } = setup();
    db.updateWorkspaceMemory(dev.id, { lifeReadable: true });
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    const policy = resolveReadPolicy({
      workspace: db.getWorkspace(life.id)!,
      workspaces: db.listWorkspaces(),
      getSettings: (id) => db.getMemorySettings(id),
    });

    const normal = claim(store, `workspace:${dev.id}`, { summary: 'normal' });
    const privateClaim = claim(store, `workspace:${dev.id}`, {
      summary: 'private',
      sensitivity: 'private',
    });
    const secret = claim(store, `workspace:${dev.id}`, {
      summary: 'secret',
      sensitivity: 'secret',
    });
    expect(claimAllowed(normal, policy)).toBe(true);
    expect(claimAllowed(privateClaim, policy)).toBe(false);
    expect(claimAllowed(secret, policy)).toBe(false);

    const portable = claim(store, 'user', { summary: 'portable', shareClass: 'portable' });
    const personal = claim(store, 'user', { summary: 'personal', shareClass: 'personal' });
    expect(claimAllowed(portable, policy)).toBe(true);
    expect(claimAllowed(personal, policy)).toBe(false);
    expect(claimAllowed(personal, { ...policy, profileMode: 'full' })).toBe(true);
    expect(claimAllowed(portable, { ...policy, profileMode: 'off' })).toBe(false);

    const brief = buildMemoryBrief(store, policy)!;
    expect(brief.markdown).toContain('normal');
    expect(brief.markdown).not.toContain('private');
    expect(brief.markdown).not.toContain('secret');
    expect(brief.markdown).not.toContain('personal');
  });
});
