import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import { recallQuery, shouldRecall } from '../src/memory/recall';
import { MemoryStore } from '../src/memory/store';
import { memoryRecall } from '../src/runs/memory-recall';

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

function setup() {
  const db = new Db(':memory:');
  dbs.push(db);
  const store = new MemoryStore(tmpDir('memory'));
  stores.push(store);
  const { workspace } = db.ensureLifeWorkspace(tmpDir('life'));
  const session = db.createSession({
    id: 's-recall',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  const ctx = { db, memory: store } as unknown as AppContext;
  return { db, store, workspace, session, ctx };
}

describe('recall triggers', () => {
  it('fires only on explicit memory cues', () => {
    expect(shouldRecall('上次我说过什么？')).toBe(true);
    expect(shouldRecall('你还记得上海那件事吗')).toBe(true);
    expect(shouldRecall('last time we discussed this')).toBe(true);
    expect(shouldRecall('帮我写个函数')).toBe(false);
  });

  it('builds CJK n-gram terms after stripping the cue', () => {
    const query = recallQuery('上次我说过上海那件事');
    expect(query.split(' ')).toContain('上海');
    expect(query).not.toContain('上次');
  });
});

describe('memory recall', () => {
  it('injects matching claims when the prompt refers to the past', () => {
    const { store, workspace, session, ctx } = setup();
    store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '住在上海',
      confidence: 0.8,
      importance: 0.8,
    });

    const result = memoryRecall(
      ctx,
      session,
      workspace,
      '上次我说过上海那件事，后来怎么样了？',
    );
    expect(result).not.toBeNull();
    expect(result!.prefix).toContain('住在上海');
    expect(result!.hits).toBe(1);
  });

  it('recalls relevant history without an explicit cue', () => {
    const { store, workspace, session, ctx } = setup();
    store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'auth',
      objectText: 'JWT',
      kind: 'fact',
      summary: '登录页使用 JWT 鉴权',
      confidence: 0.8,
      importance: 0.8,
    });
    const result = memoryRecall(ctx, session, workspace, '登录页是怎么鉴权的？');
    expect(result?.prefix).toContain('登录页使用 JWT 鉴权');

    expect(memoryRecall(ctx, session, workspace, '帮我写个排序函数')).toBeNull();
  });

  it('recalls open loops on continue cues', () => {
    const { store, workspace, session, ctx } = setup();
    store.upsertLoopCandidate({
      scope: `workspace:${workspace.id}`,
      endId: null,
      title: '补登录重构集成测试',
    });
    const result = memoryRecall(ctx, session, workspace, '继续');
    expect(result?.prefix).toContain('未完成');
    expect(result?.prefix).toContain('补登录重构集成测试');
  });

  it('does not recall a claim the operator marked wrong', () => {
    const { store, workspace, session, ctx } = setup();
    const claim = store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'auth',
      objectText: 'JWT',
      kind: 'fact',
      summary: '登录页使用 JWT 鉴权',
      confidence: 0.8,
      importance: 0.8,
    });
    expect(memoryRecall(ctx, session, workspace, '登录页是怎么鉴权的？')).not.toBeNull();

    store.addFeedback({ targetType: 'claim', targetId: claim.id, action: 'wrong' });
    expect(memoryRecall(ctx, session, workspace, '登录页是怎么鉴权的？')).toBeNull();
  });

  it('still recalls a claim marked stale (down-weighted, not dropped)', () => {
    const { store, workspace, session, ctx } = setup();
    const claim = store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'auth',
      objectText: 'JWT',
      kind: 'fact',
      summary: '登录页使用 JWT 鉴权',
      confidence: 0.8,
      importance: 0.8,
    });
    store.addFeedback({ targetType: 'claim', targetId: claim.id, action: 'stale' });
    expect(memoryRecall(ctx, session, workspace, '登录页是怎么鉴权的？')).not.toBeNull();
  });

  it('does not recall without a cue or when injection is disabled', () => {
    const { db, store, workspace, session, ctx } = setup();
    store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '住在上海',
      confidence: 0.8,
      importance: 0.8,
    });
    expect(memoryRecall(ctx, session, workspace, '今天晚饭吃什么')).toBeNull();

    db.putMemorySettings(workspace.id, {
      enabled: true,
      injectionEnabled: false,
      providerOverride: null,
    });
    expect(
      memoryRecall(ctx, session, workspace, '上次我说过上海那件事'),
    ).toBeNull();
  });

  it('respects scope isolation and never recalls secret claims', () => {
    const { db, store, workspace, session, ctx } = setup();
    const dev = db.seedDefaultWorkspace(tmpDir('repo'), 'ask', 'flag')!;
    db.putMemorySettings(dev.id, { enabled: true, injectionEnabled: true, providerOverride: null });
    store.insertClaim({
      scope: `workspace:${dev.id}`,
      endId: null,
      predicate: 'uses_framework',
      objectText: '上海',
      kind: 'fact',
      summary: '项目在上海',
      confidence: 0.8,
      importance: 0.8,
    });
    store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'secret_note',
      objectText: '上海',
      kind: 'fact',
      summary: '上海暗号',
      sensitivity: 'secret',
      confidence: 1,
      importance: 1,
    });

    const result = memoryRecall(ctx, session, workspace, '上次说过上海的事');
    expect(result).toBeNull();
  });

  it('never recalls for command or builtin sessions', () => {
    const { workspace, ctx } = setup();
    const command = { ...ctx, db: ctx.db };
    const commandSession = {
      runtime: 'command',
      memory_mode: 'normal',
      purpose: null,
    } as never;
    expect(memoryRecall(command as AppContext, commandSession, workspace, '上次')).toBeNull();
  });
});
