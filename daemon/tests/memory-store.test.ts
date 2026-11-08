import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store';
import { claimDedupKey } from '../src/memory/extract';

const stores: MemoryStore[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): { store: MemoryStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-'));
  tmpDirs.push(dataDir);
  const store = new MemoryStore(dataDir);
  stores.push(store);
  return { store, dataDir };
}

function source(overrides: Partial<Parameters<MemoryStore['insertSource']>[0]> = {}) {
  return {
    scope: 'workspace:life-1' as const,
    workspaceId: 'life-1',
    endId: 'life-end',
    kind: 'message' as const,
    sourceTable: 'messages' as const,
    sessionId: 's-1',
    runId: 'r-1',
    messageId: 1,
    occurredAt: 1_700_000_000_000,
    content: '我上个月搬到上海了',
    ...overrides,
  };
}

describe('memory store (M0)', () => {
  it('creates the database under <dataDir>/memory and stamps the schema version', () => {
    const { store, dataDir } = openStore();
    expect(store.file).toBe(path.join(dataDir, 'memory', 'memory.db'));
    expect(fs.existsSync(store.file)).toBe(true);
    expect(store.schemaVersion()).toBe(1);
  });

  it('creates the M0 tables and the search index', () => {
    const { store } = openStore();
    store.close();
    stores.splice(0);

    const db = new DatabaseSync(path.join(tmpDirs[0], 'memory', 'memory.db'));
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name`)
      .all() as unknown as { name: string }[];
    const names = tables.map((row) => row.name);
    for (const table of [
      'mem_sources',
      'mem_claims',
      'mem_claim_evidence',
      'mem_tombstones',
      'mem_ops',
      'mem_state',
      'mem_search',
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it('dedupes sources by scope/end/session/source_table/message_id', () => {
    const { store } = openStore();
    const first = store.insertSource(source());
    const second = store.insertSource(source({ content: '内容重放，但 message id 相同' }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    expect(store.countSources('pending')).toBe(1);
  });

  it('keeps the same message id in different workspaces as separate sources', () => {
    const { store } = openStore();
    store.insertSource(source());
    store.insertSource(
      source({ scope: 'workspace:life-2', workspaceId: 'life-2' }),
    );
    expect(store.countSources('pending')).toBe(2);
  });

  it('falls back to the content hash when no stable message id exists', () => {
    const { store } = openStore();
    const first = store.insertSource(source({ messageId: null, content: '随手记的笔记' }));
    const second = store.insertSource(source({ messageId: null, content: '随手记的笔记' }));
    const third = store.insertSource(source({ messageId: null, content: '另一条笔记' }));

    expect(second.source.id).toBe(first.source.id);
    expect(third.created).toBe(true);
    expect(store.countSources('pending')).toBe(2);
  });

  it('moves a source through the status machine', () => {
    const { store } = openStore();
    const { source: row } = store.insertSource(source());
    store.setSourceStatus(row.id, 'extracted');
    expect(store.getSource(row.id)?.status).toBe('extracted');
    expect(store.listPendingSources()).toHaveLength(0);
  });

  it('records tombstones so deleted content is not re-captured', () => {
    const { store } = openStore();
    store.addTombstone({
      scope: 'workspace:life-1',
      endId: 'life-end',
      contentHash: 'sha256:deadbeef',
      reason: 'forget',
    });
    expect(store.hasTombstone('workspace:life-1', 'life-end', 'sha256:deadbeef')).toBe(true);
    expect(store.hasTombstone('workspace:life-1', 'other', 'sha256:deadbeef')).toBe(false);
  });

  it('enforces the user-only share_class constraint', () => {
    const { store } = openStore();
    expect(() =>
      store.insertClaim({
        scope: 'workspace:life-1',
        predicate: 'likes',
        kind: 'preference',
        summary: '喜欢清淡',
        shareClass: 'portable',
        confidence: 0.8,
        importance: 0.5,
      }),
    ).toThrow();

    const userClaim = store.insertClaim({
      scope: 'user',
      predicate: 'lives_in',
      kind: 'fact',
      summary: '住在上海',
      shareClass: 'portable',
      confidence: 0.9,
      importance: 0.8,
    });
    expect(userClaim.shareClass).toBe('portable');
  });

  it('merges Tier-0 duplicates by dedup key and keeps their evidence', () => {
    const { store } = openStore();
    const firstSource = store.insertSource(source());
    const secondSource = store.insertSource(source({ messageId: 2, content: '我住在上海' }));

    const first = store.insertClaim(
      {
        scope: 'workspace:life-1',
        endId: 'life-end',
        predicate: 'lives_in',
        kind: 'fact',
        summary: '住在上海',
        dedupKey: 'lives_in|上海',
        confidence: 0.8,
        importance: 0.8,
      },
      [{ sourceId: firstSource.source.id, quote: '搬到上海了' }],
    );
    const second = store.insertClaim(
      {
        scope: 'workspace:life-1',
        endId: 'life-end',
        predicate: 'lives_in',
        kind: 'fact',
        summary: '住在上海',
        dedupKey: 'lives_in|上海',
        confidence: 0.9,
        importance: 0.8,
      },
      [{ sourceId: secondSource.source.id, quote: '住在上海' }],
    );

    expect(second.id).toBe(first.id);
    expect(store.listClaims('workspace:life-1')).toHaveLength(1);
    expect(store.claimEvidence(first.id)).toHaveLength(2);
  });

  it('recomputes the dedup key after a user correction', () => {
    const { store } = openStore();
    const firstSource = store.insertSource(source());
    const first = store.insertClaim(
      {
        scope: 'workspace:life-1',
        endId: 'life-end',
        predicate: 'lives_in',
        objectText: '上海',
        kind: 'fact',
        summary: '住在上海',
        dedupKey: claimDedupKey('lives_in', '上海'),
        confidence: 0.8,
        importance: 0.8,
      },
      [{ sourceId: firstSource.source.id, quote: '我上个月搬到上海了' }],
    );

    const corrected = store.correctClaim(first.id, { objectText: '杭州', summary: '住在杭州' });
    expect(corrected).toMatchObject({ authority: 'user_confirmed', objectText: '杭州' });

    const secondSource = store.insertSource(source({ messageId: 2, content: '我住在杭州' }));
    const merged = store.insertClaim(
      {
        scope: 'workspace:life-1',
        endId: 'life-end',
        predicate: 'lives_in',
        objectText: '杭州',
        kind: 'fact',
        summary: '住在杭州',
        dedupKey: claimDedupKey('lives_in', '杭州'),
        confidence: 0.9,
        importance: 0.8,
      },
      [{ sourceId: secondSource.source.id, quote: '我住在杭州' }],
    );

    expect(merged.id).toBe(first.id);
    expect(store.listClaims('workspace:life-1')).toHaveLength(1);
    expect(store.claimEvidence(first.id)).toHaveLength(2);
  });
});
