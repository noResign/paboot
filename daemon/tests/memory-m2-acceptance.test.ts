import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store';

const stores: MemoryStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-m2-'));
  dirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}

describe('M2 acceptance', () => {
  it('S6: alias upsert and explicit merge stay reversible', () => {
    const store = openStore();
    const scope = 'workspace:life-1';
    const person = store.upsertEntity({
      scope,
      kind: 'person',
      name: '张女士',
      aliases: ['我妈'],
    });
    const alias = store.upsertEntity({
      scope,
      kind: 'person',
      name: '我妈',
      aliases: ['母亲'],
    });
    expect(alias.id).toBe(person.id);
    expect(alias.aliases).toEqual(expect.arrayContaining(['母亲']));

    const other = store.upsertEntity({ scope, kind: 'person', name: '张阿姨' });
    const claim = store.insertClaim({
      scope,
      entityId: other.id,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '张阿姨住在上海',
      confidence: 0.8,
      importance: 0.8,
    });

    store.mergeEntities(other.id, person.id, 'operator');
    expect(store.getClaim(claim.id)?.entityId).toBe(person.id);
    expect(store.getEntity(person.id)?.aliases).toContain('张阿姨');

    store.unmergeEntities(other.id, 'operator');
    expect(store.getClaim(claim.id)?.entityId).toBe(other.id);
    expect(store.getEntity(person.id)?.aliases).not.toContain('张阿姨');
  });

  it('S7: non-overlapping values are history and later values supersede', () => {
    const store = openStore();
    const scope = 'workspace:life-1';

    const oldPlace = store.insertClaim({
      scope,
      endId: null,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '以前住在上海',
      validFrom: 1_000,
      validTo: 2_000,
      confidence: 0.8,
      importance: 0.8,
    });
    const newPlace = store.insertClaim({
      scope,
      endId: null,
      predicate: 'lives_in',
      objectText: '杭州',
      kind: 'fact',
      summary: '现在住在杭州',
      validFrom: 3_000,
      confidence: 0.8,
      importance: 0.8,
    });
    expect(oldPlace.status).toBe('active');
    expect(newPlace.status).toBe('active');

    const oldJob = store.insertClaim({
      scope,
      endId: null,
      predicate: 'works_at',
      objectText: '甲公司',
      kind: 'fact',
      summary: '在甲公司工作',
      validFrom: 1_000,
      confidence: 0.8,
      importance: 0.8,
    });
    const newJob = store.insertClaim({
      scope,
      endId: null,
      predicate: 'works_at',
      objectText: '乙公司',
      kind: 'fact',
      summary: '在乙公司工作',
      validFrom: 2_000,
      confidence: 0.8,
      importance: 0.8,
    });
    expect(store.getClaim(oldJob.id)).toMatchObject({
      status: 'superseded',
      supersededBy: newJob.id,
      validTo: 2_000,
    });
    expect(newJob.status).toBe('active');
  });

  it('S7: ambiguous equal-start conflicts become disputed, not silent merges', () => {
    const store = openStore();
    const scope = 'workspace:life-1';
    const first = store.insertClaim({
      scope,
      endId: null,
      predicate: 'name',
      objectText: '张三',
      kind: 'profile',
      summary: '名字是张三',
      validFrom: 1_000,
      confidence: 0.8,
      importance: 0.8,
    });
    const second = store.insertClaim({
      scope,
      endId: null,
      predicate: 'name',
      objectText: '李四',
      kind: 'profile',
      summary: '名字是李四',
      validFrom: 1_000,
      confidence: 0.85,
      importance: 0.8,
    });
    expect(store.getClaim(first.id)?.status).toBe('disputed');
    expect(store.getClaim(second.id)?.status).toBe('disputed');
    expect(store.listDisputes(scope)).toHaveLength(1);

    store.resolveDispute(second.id, first.id, 'new', 'operator');
    expect(store.getClaim(second.id)).toMatchObject({
      status: 'active',
      authority: 'user_confirmed',
    });
    expect(store.getClaim(first.id)).toMatchObject({
      status: 'superseded',
      supersededBy: second.id,
    });
  });

  it('S7: user_confirmed facts are never auto-superseded', () => {
    const store = openStore();
    const scope = 'workspace:life-1';
    const confirmed = store.insertClaim({
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
    expect(store.getClaim(confirmed.id)?.status).toBe('active');
    expect(store.getClaim(incoming.id)?.status).toBe('disputed');
  });

  it('S15: personal scopes auto-link, dev never does', () => {
    const store = openStore();
    const personal = ['user', 'workspace:life-1'] as const;
    const life = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张女士',
    });
    store.upsertEntity({ scope: 'user', kind: 'person', name: '张女士' });
    store.autoLinkPersonalEntity(life, personal);
    expect(store.listEntityLinks('workspace:life-1')).toHaveLength(1);

    const dev = store.upsertEntity({
      scope: 'workspace:dev-a',
      kind: 'person',
      name: '张女士',
    });
    store.autoLinkPersonalEntity(dev, personal);
    expect(store.listEntityLinks('workspace:dev-a')).toHaveLength(0);
  });

  it('D33: Tier-1 only records candidates and rare tokens veto false merges', () => {
    const store = openStore();
    const scope = 'workspace:life-1';
    for (let index = 0; index < 20; index += 1) {
      store.insertClaim({
        scope,
        endId: null,
        predicate: `filler_${index}`,
        objectText: `填充 ${index}`,
        kind: 'fact',
        summary: `无关记录 ${index}`,
        confidence: 0.8,
        importance: 0.8,
      });
    }
    const existing = store.insertClaim({
      scope,
      endId: null,
      predicate: 'likes',
      objectText: '手冲咖啡',
      kind: 'preference',
      summary: '喜欢手冲咖啡',
      confidence: 0.8,
      importance: 0.8,
    });
    const similar = store.insertClaim({
      scope,
      endId: null,
      predicate: 'likes',
      objectText: '手冲黑咖啡',
      kind: 'preference',
      summary: '喜欢手冲咖啡',
      confidence: 0.8,
      importance: 0.8,
    });
    const candidates = store.listClaimDuplicates(scope);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.every((item) => item.status === 'pending')).toBe(true);
    expect(store.getClaim(existing.id)?.status).toBe('active');
    expect(store.getClaim(similar.id)?.status).toBe('active');

    store.insertClaim({
      scope,
      endId: null,
      predicate: 'uses',
      objectText: 'ffmpeg-7.1',
      kind: 'fact',
      summary: '使用 ffmpeg-7.1 转码',
      confidence: 0.8,
      importance: 0.8,
    });
    const before = store.listClaimDuplicates(scope).length;
    const otherVersion = store.insertClaim({
      scope,
      endId: null,
      predicate: 'uses',
      objectText: 'ffmpeg-6.1',
      kind: 'fact',
      summary: '使用 ffmpeg-6.1 转码',
      confidence: 0.8,
      importance: 0.8,
    });
    expect(store.listClaimDuplicates(scope).length).toBe(before);
    expect(store.getClaim(otherVersion.id)?.status).toBe('active');
  });
});
