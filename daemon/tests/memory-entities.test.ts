import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { EntityOperationError, MemoryStore } from '../src/memory/store';

const stores: MemoryStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-entities-'));
  dirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}

describe('memory entities', () => {
  it('matches canonical names and aliases inside the scope', () => {
    const store = openStore();
    const first = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张女士',
      aliases: ['我妈'],
    });
    const second = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张女士',
      aliases: ['母亲'],
    });
    expect(second.id).toBe(first.id);
    expect(second.aliases).toEqual(expect.arrayContaining(['我妈', '母亲']));

    const alias = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '我妈',
    });
    expect(alias.id).toBe(first.id);
    expect(store.listEntities('workspace:life-1')).toHaveLength(1);
  });

  it('merges source aliases and repoints claim references', () => {
    const store = openStore();
    const source = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张阿姨',
      aliases: ['阿姨'],
    });
    const target = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张女士',
    });
    const claim = store.insertClaim({
      scope: 'workspace:life-1',
      endId: null,
      entityId: target.id,
      predicate: 'relation',
      objectText: '张阿姨',
      objectEntityId: source.id,
      kind: 'relation',
      summary: '张女士是亲戚',
      confidence: 0.8,
      importance: 0.8,
    });

    store.mergeEntities(source.id, target.id, 'test');
    expect(store.getEntity(source.id)).toMatchObject({
      status: 'merged',
      mergedInto: target.id,
    });
    expect(store.getClaim(claim.id)?.objectEntityId).toBe(target.id);
    expect(store.getEntity(target.id)?.aliases).toContain('张阿姨');
  });

  it('links, but does not merge, across scopes', () => {
    const store = openStore();
    const a = store.upsertEntity({ scope: 'workspace:dev-a', kind: 'person', name: '张女士' });
    const b = store.upsertEntity({ scope: 'user', kind: 'person', name: '张女士' });
    store.linkEntities(a.id, b.id, 'same_person', 'test');
    expect(store.getEntity(a.id)?.status).toBe('active');
    expect(store.getEntity(b.id)?.status).toBe('active');
  });

  it('counts active non-secret claims on both sides of an entity', () => {
    const store = openStore();
    const person = store.upsertEntity({ scope: 'workspace:life-1', kind: 'person', name: '张女士' });
    const base = {
      scope: 'workspace:life-1' as const,
      predicate: 'likes',
      kind: 'fact' as const,
      confidence: 0.8,
      importance: 0.8,
    };
    store.insertClaim({ ...base, entityId: person.id, summary: '主语命中' });
    store.insertClaim({ ...base, objectEntityId: person.id, summary: '宾语命中' });
    store.insertClaim({
      ...base,
      entityId: person.id,
      objectEntityId: person.id,
      summary: '两列同时命中',
    });
    store.insertClaim({ ...base, entityId: person.id, summary: '已过期', status: 'superseded' });
    store.insertClaim({
      ...base,
      entityId: person.id,
      summary: '机密',
      sensitivity: 'secret',
    });

    const [item] = store.listEntitiesWithCounts('workspace:life-1');
    expect(item?.claimCount).toBe(3);
    expect(store.countEntityClaims(person.id)).toBe(3);
  });

  it('hides merged sources and records rollback data in mem_ops', () => {
    const store = openStore();
    const source = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张阿姨',
      aliases: ['阿姨'],
    });
    const target = store.upsertEntity({ scope: 'workspace:life-1', kind: 'person', name: '张女士' });
    const entityClaim = store.insertClaim({
      scope: 'workspace:life-1',
      entityId: source.id,
      predicate: 'lives_in',
      kind: 'fact',
      summary: '张阿姨住在上海',
      confidence: 0.8,
      importance: 0.8,
    });
    const objectClaim = store.insertClaim({
      scope: 'workspace:life-1',
      objectEntityId: source.id,
      predicate: 'knows',
      kind: 'relation',
      summary: '张女士认识张阿姨',
      confidence: 0.8,
      importance: 0.8,
    });

    store.mergeEntities(source.id, target.id, 'test');

    const listed = store.listEntitiesWithCounts('workspace:life-1');
    expect(listed.map((entity) => entity.id)).toEqual([target.id]);
    expect(listed[0]?.claimCount).toBe(2);

    const db = new DatabaseSync(store.file);
    const row = db
      .prepare(`SELECT payload_json AS payload FROM mem_ops WHERE batch_key = ?`)
      .get(`merge-entity:${source.id}:${target.id}`) as { payload: string } | undefined;
    db.close();
    const payload = JSON.parse(row?.payload ?? '{}') as {
      merged: string;
      kind: string;
      source: { canonicalName: string };
      movedClaims: { entityIds: string[]; objectEntityIds: string[] };
    };
    expect(payload.merged).toBe(source.id);
    expect(payload.kind).toBe('person');
    expect(payload.source.canonicalName).toBe('张阿姨');
    expect(payload.movedClaims.entityIds).toEqual([entityClaim.id]);
    expect(payload.movedClaims.objectEntityIds).toEqual([objectClaim.id]);
  });

  it('unmerges a merge and restores claims, aliases and links', () => {
    const store = openStore();
    const source = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张阿姨',
      aliases: ['阿姨'],
    });
    const target = store.upsertEntity({
      scope: 'workspace:life-1',
      kind: 'person',
      name: '张女士',
      aliases: ['大姐'],
    });
    const entityClaim = store.insertClaim({
      scope: 'workspace:life-1',
      entityId: source.id,
      predicate: 'lives_in',
      kind: 'fact',
      summary: '张阿姨住在上海',
      confidence: 0.8,
      importance: 0.8,
    });
    const objectClaim = store.insertClaim({
      scope: 'workspace:life-1',
      objectEntityId: source.id,
      predicate: 'knows',
      kind: 'relation',
      summary: '张女士认识张阿姨',
      confidence: 0.8,
      importance: 0.8,
    });

    store.mergeEntities(source.id, target.id, 'test');
    const mergedList = store.listEntitiesWithCounts('workspace:life-1', 'merged');
    expect(mergedList).toHaveLength(1);
    expect(mergedList[0]).toMatchObject({
      id: source.id,
      mergedInto: target.id,
      mergedIntoName: '张女士',
    });
    expect(mergedList[0]?.linkCount).toBe(1);

    const restored = store.unmergeEntities(source.id, 'test');
    expect(restored).toMatchObject({ status: 'active', mergedInto: null });
    expect(store.getClaim(entityClaim.id)?.entityId).toBe(source.id);
    expect(store.getClaim(objectClaim.id)?.objectEntityId).toBe(source.id);
    expect(store.getEntity(target.id)?.aliases).toEqual(['大姐']);

    const db = new DatabaseSync(store.file);
    const [first, second] = source.id < target.id ? [source.id, target.id] : [target.id, source.id];
    const link = db
      .prepare(`SELECT relation FROM mem_entity_links WHERE entity_a = ? AND entity_b = ?`)
      .get(first, second) as { relation: string } | undefined;
    db.close();
    expect(link).toBeUndefined();

    try {
      store.unmergeEntities(source.id, 'test');
      throw new Error('expected unmerge to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(EntityOperationError);
      expect((err as EntityOperationError).code).toBe('source_not_merged');
    }
  });
});
