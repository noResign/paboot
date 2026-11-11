import { afterEach, describe, expect, it } from 'vitest';
import { buildBuiltinStepPayload, buildMemoryExtractionPayload, buildRunInjectionPayload } from '../src/debug/builders';
import { encodeSnapshotPayload, MIN_SNAPSHOT_MAX_BYTES } from '../src/debug/limits';
import { DebugRecorder } from '../src/debug/recorder';
import { createRedactor, redactDeep } from '../src/debug/redact';
import { LiveContextStore } from '../src/debug/store';
import { isDebugEnabled, isDebugLive, resetDebugFlag } from '../src/platform/debug-flag';
import type {
  BuiltinStepCaptureInput,
  MemoryExtractionCaptureInput,
  RunInjectionCaptureInput,
} from '../src/debug/types';
import type { LlmRequest } from '../src/llm/types';

const SECRET = 'operator-token-1234567890';

afterEach(() => resetDebugFlag());

function llmRequest(): LlmRequest {
  return {
    provider: 'fake',
    model: 'fake-1',
    system: `system ${SECRET}`,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', mediaType: 'image/png', data: 'A'.repeat(64) },
        ],
      },
    ],
    tools: [],
    maxTokens: 128,
    signal: new AbortController().signal,
  };
}

function injectionInput(): RunInjectionCaptureInput {
  return {
    sessionId: 's-1',
    workspaceId: 'w-1',
    runId: 'r-1',
    runtime: 'claude',
    sessionKind: 'chat',
    purpose: null,
    memoryMode: 'normal',
    model: 'fake:fake-1',
    modelParameters: null,
    permissionMode: 'ask',
    extraDirs: ['/work/a'],
    toolServers: [
      { name: 'paboot_tasks', command: 'node', args: ['server.js'], env: { PABOOT_TOKEN: SECRET } },
    ],
    resumeNativeSession: false,
    knowledge: null,
    memory: {
      prefix: 'brief',
      used: 5,
      overBudget: false,
      omitted: 0,
      claims: 1,
      truncated: false,
      usedClaimIds: ['c-1'],
    },
    recall: {
      prefix: 'recall',
      used: 6,
      overBudget: false,
      omitted: 0,
      hits: 1,
      cue: true,
      query: '上海',
      terms: ['上海'],
      dropped: [{ kind: 'claim', refId: 'c-2', reason: 'not_relevant' }],
      droppedCount: 1,
    },
    merged: { prefix: 'merged', used: 11, overBudget: false, omitted: 0 },
    injectionMode: 'native-system-prompt',
    prompt: 'hi',
    promptSent: 'hi',
    systemContext: 'merged',
  };
}

describe('debug redaction', () => {
  it('replaces daemon tokens and bearer/sk- patterns', () => {
    const redactor = createRedactor([SECRET]);
    const text = redactor.text(`a ${SECRET} b Bearer abcdefgh123456 sk-abcdefgh12345678`);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[redacted]');
  });

  it('redacts tool env values but keeps keys', () => {
    const redactor = createRedactor([SECRET]);
    const servers = redactor.toolServers([
      { name: 'x', command: 'node', args: ['a'], env: { PABOOT_TOKEN: SECRET, OTHER: 'v' } },
    ]);
    expect(servers[0]).toEqual({ name: 'x', command: 'node', args: ['a'], envKeys: ['OTHER', 'PABOOT_TOKEN'] });
    expect(JSON.stringify(servers)).not.toContain(SECRET);
  });

  it('replaces image bytes with a size marker', () => {
    const redactor = createRedactor([]);
    const messages = redactor.messages(llmRequest().messages);
    expect(JSON.stringify(messages)).toContain('[image omitted: 64 base64 chars]');
  });

  it('redacts image data URLs in provider wire bodies', () => {
    const redactor = createRedactor([]);
    const redacted = redactDeep({ url: `data:image/png;base64,${'A'.repeat(40)}` }, redactor);
    expect(JSON.stringify(redacted)).toContain('[image omitted: 62 chars]');
  });
});

describe('snapshot size cap', () => {
  it('keeps small payloads untouched', () => {
    const encoded = encodeSnapshotPayload({ a: 1 }, 4096);
    expect(encoded.truncated).toBe(false);
    expect(JSON.parse(encoded.payload)).toEqual({ a: 1 });
  });

  it('truncates oversized payloads into valid JSON under the cap', () => {
    const encoded = encodeSnapshotPayload({ system: 'x'.repeat(200_000), keep: 'me' }, MIN_SNAPSHOT_MAX_BYTES);
    expect(encoded.bytes).toBeLessThanOrEqual(MIN_SNAPSHOT_MAX_BYTES);
    expect(encoded.truncated).toBe(true);
    const parsed = JSON.parse(encoded.payload) as Record<string, unknown>;
    expect(parsed['keep']).toBe('me');
    expect(String(parsed['system'])).toContain('[truncated');
  });
});

describe('payload builders', () => {
  it('builds a run-injection payload without leaking secrets', () => {
    const payload = buildRunInjectionPayload(injectionInput(), createRedactor([SECRET]));
    expect(payload['injectionMode']).toBe('native-system-prompt');
    expect(payload['memory']).toMatchObject({ usedClaimIds: ['c-1'] });
    expect(payload['recall']).toMatchObject({ query: '上海', droppedCount: 1 });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it('builds a builtin step payload with the full request', () => {
    const assembly = {
      agentId: 'builtin',
      presetId: 'p',
      presetVersion: 1,
      contextVersion: 'ctx',
      system: {
        stableText: 'stable',
        dynamicText: 'dynamic',
        text: `system ${SECRET}`,
        sections: [{ id: 's1', order: 1, stability: 'stable', trust: 'system', text: `sec ${SECRET}` }],
        omitted: [],
        overBudget: false,
        version: 'sv',
      },
      runtimeContext: {
        text: 'runtime',
        contributions: [
          { source: 'memory:brief', kind: 'memory', stability: 'dynamic', trust: 'workspace', priority: 8, content: 'brief' },
        ],
        omitted: [],
        overBudget: false,
        version: 'rv',
      },
    };
    const input: BuiltinStepCaptureInput = {
      sessionId: 's-1',
      workspaceId: 'w-1',
      runId: 'r-1',
      step: 2,
      provider: 'fake',
      model: 'fake-1',
      request: llmRequest(),
      assembly: assembly as never,
      estimatedTokens: 42,
      wireBody: { messages: [{ content: 'x' }] },
    };
    const payload = buildBuiltinStepPayload(input, createRedactor([SECRET]));
    expect(payload).toMatchObject({ step: 2, estimatedTokens: 42, systemVersion: 'sv', contextVersion: 'ctx' });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain('AAAAAAAA');
  });

  it('builds a memory extraction payload with request and response', () => {
    const request = llmRequest();
    const input: MemoryExtractionCaptureInput = {
      batchKey: 'batch',
      attempt: 2,
      maxAttempts: 2,
      provider: 'fake',
      model: 'fake-1',
      workspaceId: null,
      scope: 'user',
      sessionId: 's-1',
      runId: 'r-1',
      sourceIds: ['src-1'],
      request,
      completion: { text: 'result', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } },
      error: null,
      durationMs: 12,
      deterministic: false,
      willRetry: false,
      failureState: null,
    };
    const payload = buildMemoryExtractionPayload(input, createRedactor([SECRET]));
    expect(payload).toMatchObject({ attempt: 2, response: 'result', durationMs: 12 });
    expect(payload['user']).toContain('hello');
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });
});

describe('live store', () => {
  it('tracks run lifecycle and emits notifications', () => {
    const store = new LiveContextStore();
    const events: string[] = [];
    store.subscribe((event) => events.push(event.type));
    store.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: 'w-1', runtime: 'builtin', model: 'm' });
    store.appendRunSnapshot('r-1', {
      kind: 'run-injection',
      step: null,
      provider: null,
      model: 'm',
      payload: {},
      bytes: 2,
      truncated: false,
      createdAt: 1,
    });
    store.appendRunSnapshot('r-1', {
      kind: 'builtin-step',
      step: 1,
      provider: 'p',
      model: 'm',
      payload: {},
      bytes: 2,
      truncated: false,
      createdAt: 2,
    });
    store.finishRun('r-1', { status: 'succeeded', endedAt: 3 });
    expect(events).toEqual(['run-started', 'snapshot', 'snapshot', 'run-finished']);
    const run = store.getRun('r-1');
    expect(run).toMatchObject({ status: 'succeeded', stepCount: 1, snapshotCount: 2 });
    expect(store.listRuns()).toHaveLength(1);
  });

  it('caps builtin steps and memory snapshots', () => {
    const store = new LiveContextStore();
    store.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: null, runtime: 'builtin', model: null });
    for (let i = 0; i < 105; i += 1) {
      store.appendRunSnapshot('r-1', {
        kind: 'builtin-step',
        step: i + 1,
        provider: 'p',
        model: 'm',
        payload: {},
        bytes: 2,
        truncated: false,
        createdAt: i,
      });
    }
    expect(store.getRun('r-1')?.steps).toHaveLength(100);
    for (let i = 0; i < 55; i += 1) {
      store.appendMemorySnapshot('s-1', {
        kind: 'memory-extraction',
        step: null,
        provider: 'p',
        model: 'm',
        payload: {},
        bytes: 2,
        truncated: false,
        createdAt: i,
      });
    }
    expect(store.getSessionMemory('s-1').snapshots).toHaveLength(50);
    expect(store.listMemorySessions()).toEqual([
      expect.objectContaining({ sessionId: 's-1', count: 50 }),
    ]);
  });

  it('updates a step snapshot with its outcome', () => {
    const store = new LiveContextStore();
    store.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: null, runtime: 'builtin', model: null });
    const snapshot = store.appendRunSnapshot('r-1', {
      kind: 'builtin-step',
      step: 1,
      provider: 'p',
      model: 'm',
      payload: { a: 1 },
      bytes: 2,
      truncated: false,
      createdAt: 1,
      outcome: 'running',
    });
    const events: string[] = [];
    store.subscribe((event) => events.push(event.type));
    const updated = store.updateSnapshot(snapshot!.id, {
      payload: { a: 1, outcome: { status: 'ok' } },
      bytes: 24,
      truncated: false,
      outcome: 'ok',
      durationMs: 5,
      error: null,
    });
    expect(updated).toMatchObject({ outcome: 'ok', durationMs: 5, error: null });
    expect(events).toContain('snapshot-updated');
  });

  it('evicts the oldest snapshots when the total byte cap is exceeded', () => {
    const store = new LiveContextStore({ maxTotalBytes: 512 * 1024 });
    store.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: null, runtime: 'builtin', model: null });
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const snapshot = store.appendRunSnapshot('r-1', {
        kind: 'builtin-step',
        step: i + 1,
        provider: 'p',
        model: 'm',
        payload: {},
        bytes: 200 * 1024,
        truncated: false,
        createdAt: i,
      });
      ids.push(snapshot!.id);
    }
    expect(store.getSnapshot(ids[0]!)).toBeNull();
    expect(store.getRun('r-1')!.steps.length).toBeLessThan(5);
  });

  it('prunes finished runs after the retention window', () => {
    const store = new LiveContextStore();
    store.startRun({ runId: 'old', sessionId: 's-1', workspaceId: null, runtime: 'claude', model: null, startedAt: 1 });
    store.finishRun('old', { status: 'succeeded', endedAt: 1000 });
    store.startRun({ runId: 'new', sessionId: 's-1', workspaceId: null, runtime: 'claude', model: null, startedAt: 5000 });
    store.finishRun('new', { status: 'succeeded', endedAt: 9000 });
    const removed = store.pruneFinished(10_000, 5_000);
    expect(removed).toEqual(['old']);
    expect(store.getRun('old')).toBeNull();
    expect(store.getRun('new')).not.toBeNull();
  });
});

describe('capture mode', () => {
  it('auto mode captures only while a debug client is attached', async () => {
    const recorder = new DebugRecorder({
      mode: 'auto',
      maxBytes: 4096,
      secrets: [],
      idleClearMs: 5,
    });
    recorder.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: null, runtime: 'claude', model: null });
    expect(recorder.active).toBe(false);
    expect(isDebugEnabled()).toBe(true);
    expect(isDebugLive()).toBe(false);
    expect(recorder.store.getRun('r-1')).toBeNull();

    const unsubscribe = recorder.subscribe(() => undefined);
    expect(recorder.active).toBe(true);
    expect(isDebugLive()).toBe(true);
    recorder.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: null, runtime: 'claude', model: null });
    expect(recorder.store.getRun('r-1')).not.toBeNull();

    unsubscribe();
    expect(isDebugLive()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorder.active).toBe(false);
    expect(recorder.store.getRun('r-1')).toBeNull();
  });

  it('off mode never captures, even with a subscriber', () => {
    const recorder = new DebugRecorder({ mode: 'off', maxBytes: 4096, secrets: [] });
    recorder.subscribe(() => undefined);
    recorder.startRun({ runId: 'r-1', sessionId: 's-1', workspaceId: null, runtime: 'claude', model: null });
    expect(recorder.active).toBe(false);
    expect(isDebugEnabled()).toBe(false);
    expect(isDebugLive()).toBe(false);
    expect(recorder.store.getRun('r-1')).toBeNull();
  });
});
