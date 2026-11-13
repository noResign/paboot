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

describe('brief plan convergence (D37)', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-11-13T00:00:00Z');

  function planClaim(overrides: Partial<CreateClaimInput> = {}): CreateClaimInput {
    const summary = overrides.summary ?? '计划';
    return claim({
      predicate: 'plan',
      kind: 'fact',
      summary,
      // Distinct object text per claim: identical objects are Tier-0 duplicates.
      objectText: summary,
      ...overrides,
    });
  }

  it('renders plan claims in their own block, not under 关于你 / 偏好', () => {
    const { store } = setup();
    store.insertClaim(claim({ summary: '住在上海' }));
    store.insertClaim(planClaim({ summary: '先做 P2', validFrom: now - DAY }));

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    const [about, plans] = brief.markdown.split('## 当前计划');
    expect(about).toContain('## 关于你');
    expect(about).not.toContain('先做 P2');
    expect(plans).toContain('先做 P2');
    expect(plans!.indexOf('先做 P2')).toBeLessThan(plans!.indexOf('## 注意'));
    // Plan lines never leak into the identity / preference blocks.
    expect(about).not.toContain('## 当前计划');
  });

  it('shows only the newest focus and marks it as the current main line', () => {
    const { store } = setup();
    store.insertClaim(planClaim({ predicate: 'focus', summary: '旧主线', validFrom: now - 20 * DAY }));
    store.insertClaim(planClaim({ predicate: 'focus', summary: '新主线', validFrom: now - DAY }));

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.markdown).toContain('[当前主线] 新主线');
    expect(brief.markdown).not.toContain('旧主线');
  });

  it('caps other plans at the newest two and drops stale unreinforced ones', () => {
    const { store } = setup();
    store.insertClaim(planClaim({ summary: '计划 A', validFrom: now - 40 * DAY }));
    store.insertClaim(planClaim({ summary: '计划 B', validFrom: now - 3 * DAY }));
    store.insertClaim(planClaim({ summary: '计划 C', validFrom: now - 2 * DAY }));
    store.insertClaim(planClaim({ summary: '计划 D', validFrom: now - DAY }));

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.markdown).toContain('计划 C');
    expect(brief.markdown).toContain('计划 D');
    expect(brief.markdown).not.toContain('计划 B');
    // Stale and unreinforced: decayed, not "current".
    expect(brief.markdown).not.toContain('计划 A');
  });

  it('keeps a stale plan that was reinforced', () => {
    const { store } = setup();
    const reinforced = store.insertClaim(
      planClaim({ summary: '长期计划', validFrom: now - 40 * DAY }),
    );
    store.reinforceClaim(reinforced.id);

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.markdown).toContain('长期计划');
  });

  it('reports only injected plan ids in usedClaimIds', () => {
    const { store } = setup();
    const kept = store.insertClaim(planClaim({ summary: '保留', validFrom: now - DAY }));
    const convergedOut = store.insertClaim(
      planClaim({ summary: '被收敛掉', validFrom: now - 60 * DAY }),
    );

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.usedClaimIds).toContain(kept.id);
    expect(brief.usedClaimIds).not.toContain(convergedOut.id);
  });

  it('tells the reader that older plans are still searchable', () => {
    const { store } = setup();
    store.insertClaim(planClaim({ summary: '计划 X', validFrom: now - DAY }));
    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.markdown).toContain('search_memory');
  });
});

describe('brief feedback ranking (D38)', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-11-13T00:00:00Z');

  it('drops a claim the operator marked wrong', () => {
    const { store } = setup();
    const wrong = store.insertClaim(claim({ summary: '记错的地址', objectText: '北京' }));
    store.insertClaim(claim({ summary: '住在上海' }));
    store.addFeedback({ targetType: 'claim', targetId: wrong.id, action: 'wrong' });

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.markdown).not.toContain('记错的地址');
    expect(brief.usedClaimIds).not.toContain(wrong.id);
  });

  it('keeps a claim marked stale but ranks it below an unmarked one', () => {
    const { store } = setup();
    const stale = store.insertClaim(
      claim({
        predicate: 'likes',
        kind: 'preference',
        objectText: '旧爱好',
        summary: '旧爱好',
        importance: 0.9,
      }),
    );
    const fresh = store.insertClaim(
      claim({
        predicate: 'likes',
        kind: 'preference',
        objectText: '新爱好',
        summary: '新爱好',
        importance: 0.5,
      }),
    );
    store.addFeedback({ targetType: 'claim', targetId: stale.id, action: 'stale' });

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.usedClaimIds).toContain(stale.id);
    // Higher `importance` no longer wins: the stale penalty (300) dominates it.
    expect(brief.usedClaimIds.indexOf(fresh.id)).toBeLessThan(brief.usedClaimIds.indexOf(stale.id));
  });

  it('lets helpful feedback lift a claim', () => {
    const { store } = setup();
    const low = store.insertClaim(
      claim({ predicate: 'likes', kind: 'preference', objectText: 'A', summary: 'A', importance: 0.5 }),
    );
    const lifted = store.insertClaim(
      claim({ predicate: 'likes', kind: 'preference', objectText: 'B', summary: 'B', importance: 0.5 }),
    );
    for (let index = 0; index < 3; index += 1) {
      store.addFeedback({ targetType: 'claim', targetId: lifted.id, action: 'helpful' });
    }

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.usedClaimIds.indexOf(lifted.id)).toBeLessThan(brief.usedClaimIds.indexOf(low.id));
  });

  it('ignores feedback older than the window', () => {
    const { store } = setup();
    const old = store.insertClaim(claim({ summary: '很久以前被标错', objectText: '北京' }));
    store.addFeedback({ targetType: 'claim', targetId: old.id, action: 'wrong' });

    // 31 days later the mark has expired, so the claim is eligible again.
    const later = now + 31 * DAY;
    const brief = buildLifeBrief(store, 'workspace:life-1', { now: later })!;
    expect(brief.markdown).toContain('很久以前被标错');
  });

  it('never lets feedback outrank user_confirmed', () => {
    const { store } = setup();
    const confirmed = store.insertClaim(
      claim({ summary: '用户确认的地址', objectText: '上海', authority: 'user_confirmed', importance: 0.1 }),
    );
    const boosted = store.insertClaim(
      claim({ predicate: 'likes', kind: 'preference', objectText: 'B', summary: '被点赞的偏好', importance: 1 }),
    );
    for (let index = 0; index < 20; index += 1) {
      store.addFeedback({ targetType: 'claim', targetId: boosted.id, action: 'helpful' });
    }

    const brief = buildLifeBrief(store, 'workspace:life-1', { now })!;
    expect(brief.usedClaimIds[0]).toBe(confirmed.id);
  });
});

describe('brief session echo filter (D39)', () => {
  const SCOPE = 'workspace:life-1' as const;

  function sourceWithSession(
    store: MemoryStore,
    sessionId: string,
    messageId: number,
    content: string,
  ): string {
    return store.insertSource({
      scope: SCOPE,
      workspaceId: 'life-1',
      endId: 'life-end',
      kind: 'message',
      sourceTable: 'messages',
      sessionId,
      runId: `r-${sessionId}-${messageId}`,
      messageId,
      occurredAt: 1_700_000_000_000 + messageId,
      content,
    }).source.id;
  }

  it('drops claims whose evidence comes only from the current session', () => {
    const { store } = setup();
    const mine = sourceWithSession(store, 's-now', 1, '我决定先做 focus 谓词');
    store.insertClaim(
      claim({ predicate: 'focus', kind: 'profile', objectText: '先做 focus', summary: '本轮计划' }),
      [{ sourceId: mine, quote: '先做 focus 谓词' }],
    );
    const older = sourceWithSession(store, 's-old', 2, '我住在上海');
    store.insertClaim(claim({ summary: '住在上海' }), [{ sourceId: older, quote: '我住在上海' }]);

    const brief = buildLifeBrief(store, SCOPE, { excludeSessionId: 's-now' })!;
    expect(brief.markdown).toContain('住在上海');
    expect(brief.markdown).not.toContain('本轮计划');
  });

  it('keeps a claim that an earlier session also reinforced', () => {
    const { store } = setup();
    const now = sourceWithSession(store, 's-now', 1, '非破坏性迁移');
    const before = sourceWithSession(store, 's-old', 2, '迁移要保留旧表');
    store.insertClaim(claim({ summary: '偏好非破坏性迁移' }), [
      { sourceId: before, quote: '迁移要保留旧表' },
      { sourceId: now, quote: '非破坏性迁移' },
    ]);

    const brief = buildLifeBrief(store, SCOPE, { excludeSessionId: 's-now' })!;
    expect(brief.markdown).toContain('偏好非破坏性迁移');
  });

  it('keeps claims with no attributable evidence instead of guessing', () => {
    const { store } = setup();
    store.insertClaim(claim({ summary: '没有来源的记忆' }));

    const brief = buildLifeBrief(store, SCOPE, { excludeSessionId: 's-now' })!;
    expect(brief.markdown).toContain('没有来源的记忆');
  });

  it('does not filter when no session is given (manual brief for the UI)', () => {
    const { store } = setup();
    const mine = sourceWithSession(store, 's-now', 1, '我决定先做 focus 谓词');
    store.insertClaim(
      claim({ predicate: 'focus', kind: 'profile', objectText: '先做 focus', summary: '本轮计划' }),
      [{ sourceId: mine, quote: '先做 focus 谓词' }],
    );

    expect(buildLifeBrief(store, SCOPE)!.markdown).toContain('本轮计划');
  });

  it('hands the freed budget to cross-session claims', () => {
    const { store } = setup();
    for (let index = 0; index < 8; index += 1) {
      const src = sourceWithSession(store, 's-now', index + 1, `本轮决定 ${index}`);
      store.insertClaim(
        claim({
          predicate: 'plan',
          kind: 'fact',
          objectText: `本轮决定 ${index}`,
          summary: `本轮决定 ${index} 的完整描述用来占用预算`,
          validFrom: Date.now() - index * 1000,
        }),
        [{ sourceId: src, quote: `本轮决定 ${index}` }],
      );
    }
    const older = sourceWithSession(store, 's-old', 99, '旧知识');
    store.insertClaim(claim({ summary: '旧知识应该被看见' }), [
      { sourceId: older, quote: '旧知识' },
    ]);

    const withFilter = buildLifeBrief(store, SCOPE, { excludeSessionId: 's-now', maxChars: 300 })!;
    expect(withFilter.markdown).toContain('旧知识应该被看见');
    expect(withFilter.markdown).not.toContain('本轮决定');
    expect(withFilter.truncated).toBe(false);
  });

  it('returns null when everything left is from this session', () => {
    const { store } = setup();
    const mine = sourceWithSession(store, 's-now', 1, '本轮决定');
    store.insertClaim(claim({ summary: '本轮才决定的' }), [
      { sourceId: mine, quote: '本轮决定' },
    ]);
    expect(buildLifeBrief(store, SCOPE, { excludeSessionId: 's-now' })).toBeNull();
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
