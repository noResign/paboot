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
});
