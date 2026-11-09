import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import {
  MemoryExtractionError,
  parseExtraction,
  parseExtractionResult,
} from '../src/memory/extract';
import type { MemoryModelSelection } from '../src/memory/model';
import { MemoryStore } from '../src/memory/store';
import type { MemorySource } from '../src/memory/types';
import { MemoryWorker } from '../src/memory/worker';

const stores: MemoryStore[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-memory-extract-'));
  tmpDirs.push(dir);
  const store = new MemoryStore(dir);
  stores.push(store);
  return store;
}

function addSource(
  store: MemoryStore,
  content: string,
  messageId = 1,
  runId = 'r-1',
): MemorySource {
  return store.insertSource({
    scope: 'workspace:life-1',
    workspaceId: 'life-1',
    endId: 'life-end',
    kind: 'message',
    sourceTable: 'messages',
    sessionId: 's-1',
    runId,
    messageId,
    occurredAt: 1_700_000_000_000 + messageId,
    content,
  }).source;
}

function fakeProvider(
  respond: (request: LlmRequest) => string | Promise<string>,
  calls: LlmRequest[] = [],
): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    async *stream() {
      // Not used by Memory.
    },
    async complete(request) {
      calls.push(request);
      return {
        text: await respond(request),
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      };
    },
  };
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

describe('extraction validation', () => {
  const source = {
    id: 'src-1',
    content: '我上个月搬到上海了，我不吃香菜。',
  } as unknown as MemorySource;

  it('accepts a claim whose quote is verbatim in the source', () => {
    const claims = parseExtraction(
      JSON.stringify({
        claims: [
          {
            predicate: 'lives_in',
            object: '上海',
            kind: 'fact',
            summary: '住在上海',
            validFrom: '2026-09',
            timePrecision: 'month',
            confidence: 0.9,
            importance: 0.8,
            sensitivity: 'normal',
            evidence: [{ sourceId: 'src-1', quote: '我上个月搬到上海了' }],
          },
        ],
      }),
      [source],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ predicate: 'lives_in', objectText: '上海' });
    expect(claims[0]?.validFrom).toBe(Date.parse('2026-09-01'));
  });

  it('drops unknown predicates, secret claims, unknown sources and bad quotes', () => {
    const claims = parseExtraction(
      JSON.stringify({
        claims: [
          {
            predicate: 'made_up',
            object: 'x',
            kind: 'fact',
            summary: 'x',
            evidence: [{ sourceId: 'src-1', quote: '我上个月搬到上海了' }],
          },
          {
            predicate: 'lives_in',
            object: '上海',
            kind: 'fact',
            summary: 'x',
            sensitivity: 'secret',
            evidence: [{ sourceId: 'src-1', quote: '我上个月搬到上海了' }],
          },
          {
            predicate: 'lives_in',
            object: '上海',
            kind: 'fact',
            summary: 'x',
            evidence: [{ sourceId: 'other', quote: '我上个月搬到上海了' }],
          },
          {
            predicate: 'lives_in',
            object: '上海',
            kind: 'fact',
            summary: 'x',
            evidence: [{ sourceId: 'src-1', quote: '我住在北京' }],
          },
        ],
      }),
      [source],
    );
    expect(claims).toHaveLength(0);
  });

  it('handles fenced JSON and skip responses', () => {
    expect(parseExtraction('```json\n{"claims":[]}\n```', [source])).toEqual([]);
    expect(parseExtraction('{"skip":true}', [source])).toEqual([]);
  });

  it('throws a retryable error for malformed JSON', () => {
    expect(() => parseExtraction('not json', [source])).toThrowError(MemoryExtractionError);
  });

  it('parses optional observations and a session summary', () => {
    const result = parseExtractionResult(
      JSON.stringify({
        claims: [],
        observations: [
          {
            kind: 'turn',
            type: 'bugfix',
            title: '修复登录页',
            subtitle: '更新 src/login.ts',
            facts: ['登录报错', '已修复'],
            narrative: '定位到 token 过期。',
            concepts: ['what-changed'],
          },
          { kind: 'turn', type: 'unknown', title: 'dropped' },
          { kind: 'turn', type: 'change', title: 'secret', sensitivity: 'secret' },
        ],
        summary: {
          request: '修复登录页',
          investigated: 'token',
          learned: 'token 过期',
          completed: '已修复',
          nextSteps: '补测试',
        },
      }),
      [source],
    );
    expect(result.claims).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: 'turn',
      type: 'bugfix',
      title: '修复登录页',
      facts: ['登录报错', '已修复'],
    });
    expect(result.summary).toMatchObject({
      request: '修复登录页',
      completed: '已修复',
      nextSteps: '补测试',
    });
  });
});

describe('memory worker', () => {
  it('turns pending sources into claims with evidence and marks them extracted', async () => {
    const store = openStore();
    const source = addSource(store, '我上个月搬到上海了，我不吃香菜。', 7);
    const provider = fakeProvider(() =>
      JSON.stringify({
        claims: [
          {
            predicate: 'lives_in',
            object: '上海',
            kind: 'fact',
            summary: '住在上海（2026-09 起）',
            validFrom: '2026-09',
            timePrecision: 'month',
            confidence: 0.9,
            importance: 0.8,
            sensitivity: 'normal',
            evidence: [{ sourceId: source.id, quote: '我上个月搬到上海了' }],
          },
          {
            predicate: 'dislikes',
            object: '香菜',
            kind: 'preference',
            summary: '不喜欢香菜',
            confidence: 0.8,
            importance: 0.5,
            evidence: [{ sourceId: source.id, quote: '我不吃香菜' }],
          },
        ],
      }),
    );
    const worker = new MemoryWorker({ store, resolveModel: async () => model(provider) });

    const result = await worker.runOnce();
    expect(result).toMatchObject({ inactive: false, processed: 1, extracted: 1, failed: 0 });
    expect(store.getSource(source.id)?.status).toBe('extracted');

    const claims = store.listClaims('workspace:life-1');
    expect(claims).toHaveLength(2);
    expect(claims[0]?.authority).toBe('derived');
    expect(store.claimEvidence(claims[0]!.id)).toHaveLength(1);
    expect(store.getState('last_consolidated_at')).not.toBeNull();
  });

  it('marks a source skipped when the model reports nothing durable', async () => {
    const store = openStore();
    const source = addSource(store, '今天天气不错。');
    const worker = new MemoryWorker({
      store,
      resolveModel: async () => model(fakeProvider(() => '{"claims":[]}')),
    });

    const result = await worker.runOnce();
    expect(result.skipped).toBe(1);
    expect(store.getSource(source.id)?.status).toBe('skipped');
  });

  it('leaves sources pending in record-only mode', async () => {
    const store = openStore();
    const source = addSource(store, '我搬到上海了');
    const worker = new MemoryWorker({ store, resolveModel: async () => null });

    const result = await worker.runOnce();
    expect(result.inactive).toBe(true);
    expect(store.getSource(source.id)?.status).toBe('pending');
  });

  it('retries a malformed response once, then parks the source after repeated failures', async () => {
    const store = openStore();
    const source = addSource(store, '我搬到上海了');
    let calls = 0;
    const provider = fakeProvider(() => {
      calls += 1;
      return 'not json';
    });
    const worker = new MemoryWorker({
      store,
      resolveModel: async () => model(provider),
      failureLimit: 1,
    });

    const first = await worker.runOnce();
    expect(calls).toBe(2);
    expect(first.failed).toBe(1);
    // failureLimit=1 parks it immediately instead of retrying forever.
    expect(store.getSource(source.id)?.status).toBe('skipped');
  });

  it('keeps sources pending after transient provider failures', async () => {
    const store = openStore();
    const source = addSource(store, '我搬到上海了');
    let calls = 0;
    const worker = new MemoryWorker({
      store,
      failureLimit: 1,
      resolveModel: async () =>
        model(
          fakeProvider(() => {
            calls += 1;
            throw new Error('429 rate limited');
          }),
        ),
    });

    const first = await worker.runOnce();
    expect(first.failed).toBe(1);
    expect(calls).toBe(1);
    expect(store.getSource(source.id)?.status).toBe('pending');

    const second = await worker.runOnce();
    expect(second.failed).toBe(1);
    expect(store.getSource(source.id)?.status).toBe('pending');
  });

  it('contains background scheduling failures instead of rejecting', async () => {
    const failingStore = {
      pendingSessionStats: () => {
        throw new Error('memory.db unavailable');
      },
    } as unknown as MemoryStore;
    const worker = new MemoryWorker({
      store: failingStore,
      resolveModel: async () => null,
      debounceMs: 1_000,
      minBatchSources: 1,
    });

    expect(() => worker.kick()).not.toThrow();
    expect(() => (worker as unknown as { safeTick(): void }).safeTick()).not.toThrow();
  });

  it('debounces a single capture instead of extracting every turn', async () => {
    const store = openStore();
    addSource(store, '我搬到上海了', 1);
    let calls = 0;
    const worker = new MemoryWorker({
      store,
      resolveModel: async () =>
        model(
          fakeProvider(() => {
            calls += 1;
            return '{"claims":[]}';
          }),
        ),
      debounceMs: 10_000,
      minBatchSources: 6,
    });

    worker.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(store.countSources('pending', 'workspace:life-1')).toBe(1);

    await worker.stop();
    await worker.runOnce();
    expect(calls).toBe(1);
    expect(store.countSources('pending', 'workspace:life-1')).toBe(0);
  });

  it('extracts immediately once the pending batch reaches the threshold', async () => {
    const store = openStore();
    for (let index = 1; index <= 6; index += 1) {
      addSource(store, `我搬到上海了 ${index}`, index);
    }
    let calls = 0;
    const worker = new MemoryWorker({
      store,
      resolveModel: async () =>
        model(
          fakeProvider(() => {
            calls += 1;
            return '{"claims":[]}';
          }),
        ),
      debounceMs: 10_000,
      minBatchSources: 6,
    });

    worker.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    expect(store.countSources('pending', 'workspace:life-1')).toBe(0);
    await worker.stop();
  });

  it('keeps one turn together even when it exceeds the character cap', async () => {
    const store = openStore();
    addSource(store, 'a'.repeat(30), 1, 'r-turn');
    addSource(store, 'b'.repeat(30), 2, 'r-turn');
    let calls = 0;
    const worker = new MemoryWorker({
      store,
      resolveModel: async () =>
        model(
          fakeProvider(() => {
            calls += 1;
            return '{"claims":[]}';
          }),
        ),
      maxBatchChars: 40,
      maxBatchSources: 10,
    });

    await worker.runOnce();
    expect(calls).toBe(1);
    expect(store.countSources('pending', 'workspace:life-1')).toBe(0);
  });

  it('splits only between whole turns', async () => {
    const store = openStore();
    addSource(store, 'turn one user', 1, 'r-1');
    addSource(store, 'turn one assistant', 2, 'r-1');
    addSource(store, 'turn two user', 3, 'r-2');
    addSource(store, 'turn two assistant', 4, 'r-2');
    let calls = 0;
    const worker = new MemoryWorker({
      store,
      resolveModel: async () =>
        model(
          fakeProvider(() => {
            calls += 1;
            return '{"claims":[]}';
          }),
        ),
      maxBatchSources: 2,
      maxBatchChars: 1_000,
    });

    await worker.runOnce();
    expect(calls).toBe(2);
    expect(store.countSources('pending', 'workspace:life-1')).toBe(0);
  });

  it('includes the preceding extracted turn as read-only context', async () => {
    const store = openStore();
    const previous = addSource(store, '我上个月搬到上海了', 1, 'r-0');
    store.setSourceStatus(previous.id, 'extracted');
    const current = addSource(store, '我在那里找了工作', 2, 'r-1');
    let prompt = '';
    const worker = new MemoryWorker({
      store,
      resolveModel: async () =>
        model(
          fakeProvider((request) => {
            prompt = String(request.messages[0]?.content ?? '');
            return '{"claims":[]}';
          }),
        ),
    });

    await worker.runOnce();
    expect(prompt).toContain(`[context ${previous.id}`);
    expect(prompt).toContain(`[source ${current.id}`);
    expect(store.countSources('pending', 'workspace:life-1')).toBe(0);
  });

  it('merges the same claim across batches and keeps both evidence rows', async () => {
    const store = openStore();
    const first = addSource(store, '我搬到上海了', 1, 'r-1');
    const second = addSource(store, '我现在住在上海。', 2, 'r-2');
    const provider = fakeProvider((request) => {
      const prompt = String(request.messages[0]?.content ?? '');
      const sourceId = /\[source ([^ |]+)/.exec(prompt)?.[1] ?? first.id;
      const quote = sourceId === first.id ? '我搬到上海了' : '我现在住在上海';
      return JSON.stringify({
        claims: [
          {
            predicate: 'lives_in',
            object: '上海',
            kind: 'fact',
            summary: '住在上海',
            confidence: 0.8,
            importance: 0.8,
            evidence: [{ sourceId, quote }],
          },
        ],
      });
    });
    const worker = new MemoryWorker({
      store,
      resolveModel: async () => model(provider),
      maxBatchSources: 1,
    });

    await worker.runOnce();
    await worker.runOnce();

    const claims = store.listClaims('workspace:life-1');
    expect(claims).toHaveLength(1);
    expect(store.claimEvidence(claims[0]!.id)).toHaveLength(2);
    expect(store.getSource(first.id)?.status).toBe('extracted');
    expect(store.getSource(second.id)?.status).toBe('extracted');
  });

  it('replaces the mechanical observation and keeps server-extracted files', async () => {
    const store = openStore();
    const source = addSource(store, '修复登录页的报错。', 1, 'r-1');
    store.upsertObservation({
      scope: 'workspace:life-1',
      endId: 'life-end',
      sessionId: 's-1',
      runId: 'r-1',
      sourceId: source.id,
      kind: 'turn',
      type: 'discovery',
      title: '机械基线',
      filesRead: ['src/login.ts'],
      filesModified: ['src/login.ts'],
    });
    const provider = fakeProvider(() =>
      JSON.stringify({
        claims: [],
        observations: [
          {
            kind: 'turn',
            type: 'bugfix',
            title: '修复登录页',
            subtitle: 'token 过期',
            facts: ['登录报错'],
            narrative: '定位到 token 过期并修复。',
            concepts: ['what-changed'],
          },
        ],
        summary: {
          request: '修复登录页',
          investigated: 'token',
          learned: 'token 过期',
          completed: '已修复',
          nextSteps: '补集成测试',
        },
      }),
    );
    const worker = new MemoryWorker({ store, resolveModel: async () => model(provider) });

    const result = await worker.runOnce();
    expect(result.extracted).toBe(1);
    const observations = store.listObservations('workspace:life-1');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      type: 'bugfix',
      title: '修复登录页',
      filesRead: ['src/login.ts'],
      filesModified: ['src/login.ts'],
    });
    const summaries = store.listSessionSummaries('workspace:life-1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      request: '修复登录页',
      completed: '已修复',
      nextSteps: '补集成测试',
      filesEdited: ['src/login.ts'],
    });
    expect(store.listOpenLoops('workspace:life-1')).toMatchObject([
      { title: '补集成测试' },
    ]);
    // A second run must not duplicate the open follow-up.
    await worker.runOnce();
    expect(store.listOpenLoops('workspace:life-1')).toHaveLength(1);
  });
});
