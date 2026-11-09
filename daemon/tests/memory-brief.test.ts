import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db, type SessionRow, type WorkspaceRow } from '../src/db/db';
import { buildLifeBrief } from '../src/memory/brief';
import { MemoryStore } from '../src/memory/store';
import type { CreateClaimInput } from '../src/memory/types';
import { memoryContext } from '../src/runs/memory-context';
import { MemoryBriefContextSource } from '../src/runtimes/builtin/context/memory';
import type { RuntimeContextCollectContext } from '../src/runtimes/builtin/runtime-context';

const dbs: Db[] = [];
const stores: MemoryStore[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

function setup(): { db: Db; store: MemoryStore; workspace: WorkspaceRow; endId: string } {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace, end } = db.ensureLifeWorkspace(tmpDir('life'));
  return { db, store, workspace, endId: end.id };
}

function claim(overrides: Partial<CreateClaimInput> = {}): CreateClaimInput {
  return {
    scope: 'workspace:life-1',
    endId: 'life-end',
    predicate: 'lives_in',
    objectText: '上海',
    kind: 'fact',
    summary: '住在上海',
    confidence: 0.8,
    importance: 0.8,
    ...overrides,
  };
}

describe('life brief', () => {
  it('renders claims with short ids and dates', () => {
    const { store } = setup();
    store.insertClaim(
      claim({ validFrom: Date.parse('2026-09-01'), timePrecision: 'month' }),
    );
    const brief = buildLifeBrief(store, 'workspace:life-1');

    expect(brief).not.toBeNull();
    expect(brief!.markdown).toContain('## 关于你');
    expect(brief!.markdown).toContain('住在上海（2026-09 起）');
    expect(brief!.markdown).toMatch(/#claim_[0-9a-f]{4}/);
    expect(brief!.markdown).toContain('可能过时');
    expect(brief!.usedClaimIds).toHaveLength(1);
  });

  it('keeps one line per predicate/object and prefers user_confirmed', () => {
    const { store } = setup();
    const derived = store.insertClaim(claim({ summary: '自动抽取：住上海', authority: 'derived' }));
    const confirmed = store.insertClaim(
      claim({ summary: '用户确认：住上海', authority: 'user_confirmed' }),
    );
    store.insertClaim(claim({ predicate: 'likes', kind: 'preference', objectText: '咖啡', summary: '喜欢咖啡' }));

    // Tier-0 merges the exact duplicate and upgrades the existing row.
    expect(confirmed.id).toBe(derived.id);
    const brief = buildLifeBrief(store, 'workspace:life-1');
    expect(brief!.markdown).toContain('用户确认：住上海');
    expect(brief!.markdown).not.toContain('自动抽取：住上海');
    expect(brief!.markdown).toContain('## 偏好');
    expect(brief!.usedClaimIds).toContain(derived.id);
  });

  it('never injects secret claims or expired claims', () => {
    const { store } = setup();
    store.insertClaim(claim({ sensitivity: 'secret', summary: '密码是 123' }));
    store.insertClaim(
      claim({ predicate: 'works_at', objectText: '旧公司', summary: '旧公司', validTo: Date.now() - 1000 }),
    );
    expect(buildLifeBrief(store, 'workspace:life-1')).toBeNull();
  });

  it('drops whole low-ranked lines under the character budget and reports truncation', () => {
    const { store } = setup();
    for (let index = 0; index < 20; index += 1) {
      store.insertClaim(
        claim({
          predicate: 'likes',
          kind: 'preference',
          objectText: `爱好-${index}`,
          summary: `喜欢很长的爱好描述 ${index} 用来把 brief 撑爆`,
          importance: index / 20,
        }),
      );
    }
    const brief = buildLifeBrief(store, 'workspace:life-1', { maxChars: 300 });

    expect(brief!.truncated).toBe(true);
    expect(brief!.charCount).toBeLessThanOrEqual(300);
    expect(brief!.usedClaimIds.length).toBeGreaterThanOrEqual(1);
    expect(brief!.markdown).toContain('## 注意');
  });

  it('returns null when there is nothing to inject', () => {
    const { store } = setup();
    expect(buildLifeBrief(store, 'workspace:life-1')).toBeNull();
  });
});

describe('memory injection context', () => {
  function ctx(store: MemoryStore, db: Db): AppContext {
    return { memory: store, db } as unknown as AppContext;
  }

  function session(
    db: Db,
    workspace: WorkspaceRow,
    overrides: Partial<{ runtime: string; memoryMode: 'normal' | 'no_injection' | 'off'; purpose: 'task_config' }> = {},
  ): SessionRow {
    const row = db.createSession({
      id: `s-${Math.random().toString(16).slice(2)}`,
      runtime: overrides.runtime ?? 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
      purpose: overrides.purpose ?? null,
    });
    if (overrides.memoryMode) db.setSessionMemoryMode(row.id, overrides.memoryMode);
    return db.getSession(row.id) as SessionRow;
  }

  it('wraps the brief for a life chat', () => {
    const { db, store, workspace, endId } = setup();
    store.insertClaim(claim({ scope: `workspace:${workspace.id}`, endId }));
    const result = memoryContext(ctx(store, db), session(db, workspace), workspace);

    expect(result).not.toBeNull();
    expect(result!.prefix).toContain('<paboot-memory-context>');
    expect(result!.prefix).toContain('住在上海');
    expect(result!.claims).toBe(1);
  });

  it('injects for an enabled dev chat and honors injection-enabled', () => {
    const { db, store } = setup();
    const dev = db.createWorkspace({
      name: 'repo',
      path: fs.realpathSync(tmpDir('repo')),
      isDefault: false,
    });
    const devSession = session(db, dev);
    store.insertClaim(claim({ scope: `workspace:${dev.id}`, endId: null, summary: '项目使用 Compose' }));
    store.upsertObservation({
      scope: `workspace:${dev.id}`,
      endId: null,
      sessionId: devSession.id,
      runId: 'run-1',
      sourceId: null,
      kind: 'turn',
      type: 'bugfix',
      title: '修复登录页',
      subtitle: '更新布局',
    });

    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    const enabled = memoryContext(ctx(store, db), devSession, db.getWorkspace(dev.id)!);
    expect(enabled?.prefix).toContain('项目使用 Compose');
    // The current session's own timeline is already in runtime history.
    expect(enabled?.prefix).not.toContain('修复登录页');

    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: false, providerOverride: null });
    expect(memoryContext(ctx(store, db), devSession, db.getWorkspace(dev.id)!)).toBeNull();
  });

  it('never injects the current session timeline (runtime already has it)', () => {
    const { db, store, workspace } = setup();
    const a = session(db, workspace);
    store.upsertObservation({
      scope: `workspace:${workspace.id}`,
      endId: null,
      sessionId: a.id,
      runId: 'run-a',
      sourceId: null,
      kind: 'turn',
      type: 'change',
      title: '会话 A 的工作',
    });
    store.upsertSessionSummary({
      scope: `workspace:${workspace.id}`,
      endId: null,
      sessionId: a.id,
      runId: 'run-a',
      request: '继续做登录',
      nextSteps: '补测试',
    });

    expect(memoryContext(ctx(store, db), a, workspace)).toBeNull();
  });

  it('does not inject in dev, commands, builtin, authoring chats, or disabled sessions', () => {
    const { db, store, workspace, endId } = setup();
    store.insertClaim(claim({ scope: `workspace:${workspace.id}`, endId }));

    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag');
    if (!dev) throw new Error('expected dev workspace');
    const devSession = db.createSession({
      id: 's-dev',
      runtime: 'claude',
      workspaceId: dev.id,
      permissionMode: 'ask',
      cwd: dev.path,
    });

    expect(memoryContext(ctx(store, db), devSession, dev)).toBeNull();
    expect(memoryContext(ctx(store, db), session(db, workspace, { runtime: 'builtin' }), workspace)).toBeNull();
    expect(memoryContext(ctx(store, db), session(db, workspace, { runtime: 'command' }), workspace)).toBeNull();
    expect(memoryContext(ctx(store, db), session(db, workspace, { purpose: 'task_config' }), workspace)).toBeNull();
    expect(memoryContext(ctx(store, db), session(db, workspace, { memoryMode: 'off' }), workspace)).toBeNull();
    expect(memoryContext(ctx(store, db), session(db, workspace, { memoryMode: 'no_injection' }), workspace)).toBeNull();
  });

  it('builtin context obeys the session memory mode and authoring exclusion', () => {
    const { store, workspace, endId } = setup();
    store.insertClaim(claim({ scope: `workspace:${workspace.id}`, endId }));
    const source = new MemoryBriefContextSource(store);
    const context = (overrides: {
      memoryMode?: 'normal' | 'no_injection' | 'off' | null;
      purpose?: 'task_config' | null;
    } = {}) => ({
      agent: {
        workspace: { id: workspace.id, name: workspace.name, family: 'life', root: workspace.path },
      },
      session: {
        id: 's-builtin',
        workspaceId: workspace.id,
        agentId: 'builtin',
        memoryMode: overrides.memoryMode === undefined ? 'normal' : overrides.memoryMode,
        purpose: overrides.purpose ?? null,
      },
    }) as unknown as RuntimeContextCollectContext;

    expect(source.collect(context())).toHaveLength(1);
    expect(source.collect(context({ memoryMode: 'off' }))).toEqual([]);
    expect(source.collect(context({ memoryMode: 'no_injection' }))).toEqual([]);
    expect(source.collect(context({ memoryMode: null }))).toEqual([]);
    expect(source.collect(context({ purpose: 'task_config' }))).toEqual([]);
  });
});
