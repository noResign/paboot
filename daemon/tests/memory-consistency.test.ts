import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store';
import type { CreateClaimInput } from '../src/memory/types';

const stores: MemoryStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-consistency-'));
  dirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}

const SCOPE = 'workspace:life-1' as const;

function claim(overrides: Partial<CreateClaimInput>): CreateClaimInput {
  return {
    scope: SCOPE,
    endId: null,
    predicate: 'lives_in',
    objectText: '上海',
    kind: 'fact',
    summary: '住在上海',
    confidence: 0.8,
    importance: 0.8,
    ...overrides,
  };
}

describe('claim consistency (M2.1)', () => {
  it('merges an exact object even without a dedup key and reinforces once per day', () => {
    const store = openStore();
    const first = store.insertClaim(claim({}), [{ sourceId: 's1', quote: '我住在上海' }]);
    const second = store.insertClaim(claim({}), [{ sourceId: 's2', quote: '我在上海' }]);
    expect(second.id).toBe(first.id);
    expect(store.listClaims(SCOPE)).toHaveLength(1);
    expect(store.claimEvidence(first.id)).toHaveLength(2);

    const reinforced = store.reinforceClaim(first.id)!;
    expect(reinforced.reinforcementDates).toHaveLength(1);
    expect(store.reinforceClaim(first.id)!.reinforcementDates).toHaveLength(1);
    expect(reinforced.confidence).toBe(first.confidence);
  });

  it('supersedes an older functional value with a newer validFrom', () => {
    const store = openStore();
    const old = store.insertClaim(
      claim({ objectText: '上海', summary: '住在上海', validFrom: Date.UTC(2026, 8, 1) }),
    );
    const next = store.insertClaim(
      claim({ objectText: '杭州', summary: '住在杭州', validFrom: Date.UTC(2026, 9, 1) }),
    );

    const reloaded = store.getClaim(old.id)!;
    expect(reloaded.status).toBe('superseded');
    expect(reloaded.supersededBy).toBe(next.id);
    expect(reloaded.validTo).toBe(Date.UTC(2026, 9, 1));
    expect(store.getClaim(next.id)?.status).toBe('active');
  });

  it('never supersedes a user-confirmed claim automatically', () => {
    const store = openStore();
    const confirmed = store.insertClaim(claim({ objectText: '上海', summary: '住在上海' }));
    store.correctClaim(confirmed.id, { objectText: '上海', summary: '我确认住在上海' });
    const incoming = store.insertClaim(claim({ objectText: '杭州', summary: '住在杭州' }));

    expect(store.getClaim(confirmed.id)?.status).toBe('active');
    expect(store.getClaim(incoming.id)?.status).toBe('disputed');
  });

  it('leaves multi-valued preferences active', () => {
    const store = openStore();
    const first = store.insertClaim(
      claim({ predicate: 'likes', objectText: '香菜', summary: '喜欢香菜' }),
    );
    const second = store.insertClaim(
      claim({ predicate: 'likes', objectText: '火锅', summary: '喜欢火锅' }),
    );
    expect(store.getClaim(first.id)?.status).toBe('active');
    expect(store.getClaim(second.id)?.status).toBe('active');
  });

  it('records Tier-1 approximate duplicates as pending candidates only', () => {
    const store = openStore();
    for (let index = 0; index < 20; index += 1) {
      store.insertClaim(
        claim({
          predicate: `filler_${index}`,
          objectText: `填充分子 ${index}`,
          summary: `无关记录 ${index}`,
        }),
      );
    }
    const first = store.insertClaim(
      claim({
        predicate: 'likes',
        objectText: '手冲咖啡',
        summary: '喜欢手冲咖啡',
      }),
    );
    // A different object (so Tier-0 does not merge) but very similar wording.
    store.insertClaim(
      claim({
        predicate: 'likes',
        objectText: '手冲黑咖啡',
        summary: '喜欢手冲咖啡',
      }),
    );

    const candidates = store.listClaimDuplicates(SCOPE);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.duplicateOf).toBe(first.id);
    expect(store.listClaims(SCOPE).filter((row) => row.status === 'active').length)
      .toBeGreaterThan(1);
  });

  it('vetoes a Tier-1 candidate over a rare identifier token', () => {
    const store = openStore();
    for (let index = 0; index < 20; index += 1) {
      store.insertClaim(
        claim({
          predicate: `filler_${index}`,
          objectText: `填充分子 ${index}`,
          summary: `无关记录 ${index}`,
        }),
      );
    }
    store.insertClaim(
      claim({ predicate: 'project_note', objectText: 'ffmpeg-7.1', summary: '使用 ffmpeg-7.1 构建' }),
    );
    store.insertClaim(
      claim({ predicate: 'project_note', objectText: 'ffmpeg-6.1', summary: '使用 ffmpeg-7.1 构建' }),
    );
    expect(store.listClaimDuplicates(SCOPE)).toHaveLength(0);
  });

  it('marks equal-time, similar-confidence contradictions disputed', () => {
    const store = openStore();
    const when = Date.UTC(2026, 9, 1);
    const a = store.insertClaim(claim({ objectText: '上海', summary: '住在上海', validFrom: when }));
    const b = store.insertClaim(claim({ objectText: '杭州', summary: '住在杭州', validFrom: when }));
    expect(store.getClaim(a.id)?.status).toBe('disputed');
    expect(store.getClaim(b.id)?.status).toBe('disputed');
  });
});
