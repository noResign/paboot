import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app/context';
import { Db } from '../src/db/db';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import { MemoryStore } from '../src/memory/store';
import type { MemoryModelSelection } from '../src/memory/model';
import type { MemorySource } from '../src/memory/types';
import { MemoryWorker, type MemoryExtractionDebugRecord } from '../src/memory/worker';
import { memoryContext } from '../src/runs/memory-context';
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
  const store = new MemoryStore(tmpDir('debug-memory'));
  stores.push(store);
  const { workspace } = db.ensureLifeWorkspace(tmpDir('life'));
  const session = db.createSession({
    id: 's-debug',
    runtime: 'claude',
    workspaceId: workspace.id,
    permissionMode: 'ask',
    cwd: workspace.path,
  });
  const ctx = { db, memory: store } as unknown as AppContext;
  return { db, store, workspace, session, ctx };
}

function addSource(store: MemoryStore, content: string, messageId = 1): MemorySource {
  return store.insertSource({
    scope: 'workspace:life-1',
    workspaceId: 'life-1',
    endId: 'life-end',
    kind: 'message',
    sourceTable: 'messages',
    sessionId: 's-1',
    runId: 'r-1',
    messageId,
    occurredAt: 1_700_000_000_000 + messageId,
    content,
  }).source;
}

function fakeProvider(respond: (request: LlmRequest) => string, calls: LlmRequest[] = []): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    async *stream() {
      // Not used by Memory.
    },
    async complete(request) {
      calls.push(request);
      return { text: respond(request), toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 } };
    },
  } as unknown as LlmProvider;
}

function model(provider: LlmProvider): MemoryModelSelection {
  return {
    provider,
    providerId: 'fake',
    model: 'fake-1',
    modelId: 'fake:fake-1',
    providerConfig: { id: 'fake' },
    modelConfig: { id: 'fake-1' },
  } as unknown as MemoryModelSelection;
}

function validExtraction(sourceId: string): string {
  return JSON.stringify({
    claims: [
      {
        predicate: 'lives_in',
        object: '上海',
        kind: 'fact',
        summary: '住在上海',
        confidence: 0.9,
        importance: 0.8,
        sensitivity: 'normal',
        evidence: [{ sourceId, quote: '我搬到上海了' }],
      },
    ],
  });
}

describe('memory injection metadata', () => {
  it('exposes the brief claim ids used by the renderer', () => {
    const { store, workspace, session, ctx } = setup();
    const claim = store.insertClaim({
      scope: `workspace:${workspace.id}`,
      endId: null,
      predicate: 'lives_in',
      objectText: '上海',
      kind: 'fact',
      summary: '住在上海',
      confidence: 0.8,
      importance: 0.8,
    });

    const result = memoryContext(ctx, session, workspace);
    expect(result).not.toBeNull();
    expect(result!.claims).toBe(1);
    expect(result!.usedClaimIds).toEqual([claim.id]);
    expect(result!.prefix).toContain('住在上海');
  });

  it('exposes recall query, cue and dropped items', () => {
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

    const result = memoryRecall(ctx, session, workspace, '上次我说过上海那件事，后来怎么样了？');
    expect(result).not.toBeNull();
    expect(result!.cue).toBe(true);
    expect(result!.query).toContain('上海');
    expect(result!.terms).toContain('上海');
    expect(Array.isArray(result!.dropped)).toBe(true);
    expect(result!.droppedCount).toBeGreaterThanOrEqual(result!.dropped.length);
    expect(result!.hits).toBeGreaterThan(0);
  });
});

describe('memory extraction debug', () => {
  it('emits one record per successful attempt with the full request', async () => {
    const store = (() => {
      const s = new MemoryStore(tmpDir('debug-extract'));
      stores.push(s);
      return s;
    })();
    const source = addSource(store, '我搬到上海了');
    const records: MemoryExtractionDebugRecord[] = [];
    const provider = fakeProvider(() => validExtraction(source.id));
    const worker = new MemoryWorker({
      store,
      resolveModel: async () => model(provider),
      onExtractionCall: (record) => records.push(record),
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ inactive: false, extracted: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      batchKey: expect.any(String),
      attempt: 1,
      maxAttempts: 2,
      provider: 'fake',
      model: 'fake-1',
      willRetry: false,
      error: null,
    });
    expect(records[0]!.request.system.length).toBeGreaterThan(0);
    expect(records[0]!.request.messages[0]?.content).toContain('我搬到上海了');
    expect(records[0]!.completion?.usage).toMatchObject({ inputTokens: 5, outputTokens: 7 });
  });

  it('emits a retry record, then the final failure state', async () => {
    const store = (() => {
      const s = new MemoryStore(tmpDir('debug-extract-fail'));
      stores.push(s);
      return s;
    })();
    addSource(store, '我搬到上海了');
    const records: MemoryExtractionDebugRecord[] = [];
    const provider = fakeProvider(() => 'not json');
    const worker = new MemoryWorker({
      store,
      resolveModel: async () => model(provider),
      onExtractionCall: (record) => records.push(record),
    });

    await worker.runOnce();

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ attempt: 1, willRetry: true, deterministic: true });
    expect(records[1]).toMatchObject({ attempt: 2, willRetry: false });
    expect(records[1]!.failureState).toMatchObject({
      consecutiveFailures: 1,
      dead: false,
    });
    expect(records[1]!.failureState?.lastError).toContain('JSON');
  });
});
