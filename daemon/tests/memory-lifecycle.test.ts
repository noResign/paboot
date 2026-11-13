import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractionSystemPrompt, parseExtraction } from '../src/memory/extract';
import { MemoryStore } from '../src/memory/store';

const stores: MemoryStore[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): { store: MemoryStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-lifecycle-'));
  tmpDirs.push(dataDir);
  const store = new MemoryStore(dataDir);
  stores.push(store);
  return { store, dataDir };
}

const SCOPE = 'workspace:dev-1' as const;
const END = 'dev-end';

function source(store: MemoryStore, messageId: number, content: string) {
  return store.insertSource({
    scope: SCOPE,
    workspaceId: 'dev-1',
    endId: END,
    kind: 'message',
    sourceTable: 'messages',
    sessionId: 's-1',
    runId: `r-${messageId}`,
    messageId,
    occurredAt: 1_700_000_000_000 + messageId,
    content,
  });
}

/** Insert one claim with evidence so conflict handling runs as in production. */
function insert(
  store: MemoryStore,
  input: {
    predicate: string;
    object: string;
    summary?: string;
    validFrom?: number | null;
    confidence?: number;
    importance?: number;
    authority?: 'derived' | 'user_confirmed';
  },
  messageId: number,
) {
  const src = source(store, messageId, `${input.predicate}:${input.object}`);
  return store.insertClaim(
    {
      scope: SCOPE,
      endId: END,
      predicate: input.predicate,
      objectText: input.object,
      kind: input.predicate === 'focus' ? 'profile' : 'fact',
      summary: input.summary ?? input.object,
      validFrom: input.validFrom ?? null,
      confidence: input.confidence ?? 0.8,
      importance: input.importance ?? 0.7,
      authority: input.authority ?? 'derived',
    },
    [{ sourceId: src.source.id, quote: `${input.predicate}:${input.object}` }],
  );
}

function activeObjects(store: MemoryStore, predicate: string): string[] {
  return store
    .listClaims(SCOPE, 'active')
    .filter((claim) => claim.predicate === predicate)
    .map((claim) => claim.objectText ?? '');
}

describe('single-valued claim lifecycle', () => {
  it('supersedes the previous focus when neither side carries a date', () => {
    const { store } = openStore();
    const first = insert(store, { predicate: 'focus', object: '先做 P2' }, 1);
    const second = insert(store, { predicate: 'focus', object: '先做 C1 抓包代理' }, 2);

    expect(activeObjects(store, 'focus')).toEqual(['先做 C1 抓包代理']);
    const superseded = store.getClaim(first.id);
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.supersededBy).toBe(second.id);
    expect(superseded?.validTo).not.toBeNull();
  });

  it('supersedes every stale active focus instead of only the newest one', () => {
    const { store } = openStore();
    insert(store, { predicate: 'focus', object: '路线 A' }, 1);
    insert(store, { predicate: 'focus', object: '路线 B' }, 2);
    insert(store, { predicate: 'focus', object: '路线 C' }, 3);

    expect(activeObjects(store, 'focus')).toEqual(['路线 C']);
    expect(
      store.listClaims(SCOPE, 'superseded').filter((claim) => claim.predicate === 'focus'),
    ).toHaveLength(2);
  });

  it('uses validFrom when present: a later start wins, an earlier one does not', () => {
    const { store } = openStore();
    const newer = insert(
      store,
      { predicate: 'focus', object: '先做 C1', validFrom: Date.UTC(2026, 10, 10) },
      1,
    );
    const older = insert(
      store,
      { predicate: 'focus', object: '先做 P2', validFrom: Date.UTC(2026, 9, 1) },
      2,
    );

    // A backfilled older decision must not evict the current main line.
    expect(store.getClaim(newer.id)?.status).toBe('active');
    expect(store.getClaim(older.id)?.status).toBe('active');

    const latest = insert(
      store,
      { predicate: 'focus', object: '先做抓包回放', validFrom: Date.UTC(2026, 10, 12) },
      3,
    );
    expect(store.getClaim(newer.id)?.status).toBe('superseded');
    expect(store.getClaim(newer.id)?.supersededBy).toBe(latest.id);
  });

  it('never auto-supersedes a user-confirmed focus', () => {
    const { store } = openStore();
    const confirmed = insert(
      store,
      { predicate: 'focus', object: '用户确认的主线', authority: 'user_confirmed' },
      1,
    );
    const incoming = insert(store, { predicate: 'focus', object: '模型推断的主线' }, 2);

    expect(store.getClaim(confirmed.id)?.status).toBe('active');
    expect(store.getClaim(incoming.id)?.status).toBe('disputed');
  });

  it('keeps plan multi-valued so parallel plans still coexist', () => {
    const { store } = openStore();
    insert(store, { predicate: 'plan', object: '先收尾记忆线遗留项' }, 1);
    insert(store, { predicate: 'plan', object: '再做评测' }, 2);

    expect(activeObjects(store, 'plan').sort()).toEqual(['先收尾记忆线遗留项', '再做评测']);
  });

  it('stays conservative for undated facts, which may be backfilled history', () => {
    const { store } = openStore();
    insert(store, { predicate: 'lives_in', object: '上海' }, 1);
    insert(store, { predicate: 'works_at', object: '某公司' }, 2);
    insert(store, { predicate: 'lives_in', object: '北京' }, 3);

    // No validFrom on either side: capture order is not evidence of a move.
    expect(activeObjects(store, 'lives_in').sort()).toEqual(['上海', '北京']);
  });
});

describe('focus extraction', () => {
  it('accepts focus as a predicate and keeps its validFrom', () => {
    const store = {
      source: {
        id: 'src-1',
        scope: SCOPE,
        kind: 'message',
        content: '接下来主线先做抓包代理',
        occurredAt: 1_700_000_000_000,
      },
    };
    const claims = parseExtraction(
      JSON.stringify({
        claims: [
          {
            predicate: 'focus',
            object: '先做 C1 抓包代理',
            kind: 'profile',
            summary: '当前主线是 C1 抓包代理',
            validFrom: '2026-11-10',
            timePrecision: 'day',
            confidence: 0.9,
            importance: 0.9,
            evidence: [{ sourceId: 'src-1', quote: '主线先做抓包代理' }],
          },
        ],
      }),
      [store.source as never],
    );

    expect(claims).toHaveLength(1);
    expect(claims[0]!.predicate).toBe('focus');
    expect(claims[0]!.validFrom).toBe(Date.UTC(2026, 10, 10));
  });

  it('documents the focus / plan distinction in the system prompt', () => {
    const prompt = extractionSystemPrompt();
    expect(prompt).toContain('focus');
    expect(prompt).toContain('plan');
    expect(prompt).toContain('同一时刻只有一条');
  });
});
