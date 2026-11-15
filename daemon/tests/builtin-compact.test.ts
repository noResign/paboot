import { describe, expect, it } from 'vitest';

import type { LlmProvider } from '../src/llm/types';
import {
  findKeepBoundary,
  planCompaction,
  summarizeCompaction,
} from '../src/runtimes/builtin/compact';
import type { TranscriptStore } from '../src/runtimes/builtin/transcript/store';
import { renderTranscriptMessages } from '../src/runtimes/builtin/transcript/render';
import type {
  NativeCompaction,
  NativeMessage,
  NativeMessageSource,
  TranscriptContentBlock,
  TranscriptRole,
} from '../src/types/transcript';

const measure = (text: string): number => text.length;

function message(
  seq: number,
  role: TranscriptRole,
  source: NativeMessageSource,
  blocks: TranscriptContentBlock[],
): NativeMessage {
  return {
    id: seq,
    threadId: 'thread-1',
    seq,
    role,
    blocks,
    source,
    runId: 'run-1',
    step: null,
    provider: null,
    model: null,
    usage: null,
    formatVersion: 1,
    createdAt: seq,
  };
}

function user(seq: number, text: string): NativeMessage {
  return message(seq, 'user', { kind: 'user' }, [{ type: 'text', text }]);
}

function assistant(seq: number, text: string): NativeMessage {
  return message(seq, 'assistant', { kind: 'model', provider: 'fake', model: 'm' }, [
    { type: 'text', text },
  ]);
}

function toolResult(seq: number, toolUseId: string, content: string): NativeMessage {
  return message(seq, 'tool', { kind: 'tool', callId: toolUseId }, [
    { type: 'tool_result', toolUseId, content },
  ]);
}

function runtimeContext(seq: number, text: string): NativeMessage {
  return message(seq, 'user', {
    kind: 'runtime-context',
    sourceKey: 'runtime-snapshot',
    version: 'v1',
  }, [{ type: 'text', text }]);
}

function conversation(): NativeMessage[] {
  return [
    user(1, 'turn one request with some detail'),
    assistant(2, 'turn one answer with some detail'),
    user(3, 'turn two request'),
    message(4, 'assistant', { kind: 'model', provider: 'fake', model: 'm' }, [
      { type: 'tool_call', id: 'call-1', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ]),
    toolResult(5, 'call-1', 'file contents'),
    user(6, 'turn three request'),
    assistant(7, 'turn three answer'),
  ];
}

describe('findKeepBoundary', () => {
  it('keeps everything when the budget covers the whole history', () => {
    const boundary = findKeepBoundary(conversation(), 10_000, measure);
    expect(boundary).not.toBeNull();
    expect(boundary!.throughSeq).toBe(0);
    expect(boundary!.olderTokens).toBe(0);
  });

  it('keeps at least the current turn and cuts on a turn boundary', () => {
    const boundary = findKeepBoundary(conversation(), 1, measure);
    expect(boundary!.keepStartIndex).toBe(5);
    expect(boundary!.throughSeq).toBe(5); // last message before "turn three"
    const messages = conversation();
    expect(messages[boundary!.keepStartIndex]!.source.kind).toBe('user');
  });

  it('grows the kept suffix until the token budget is met', () => {
    const all = conversation();
    const keepLastTwoTurns = findKeepBoundary(all, 60, measure);
    expect(keepLastTwoTurns!.keepStartIndex).toBe(2); // includes "turn two"
  });

  it('returns null when there is no real user turn', () => {
    expect(
      findKeepBoundary([runtimeContext(1, 'ctx'), assistant(2, 'hello')], 10, measure),
    ).toBeNull();
  });
});

describe('planCompaction', () => {
  it('returns the older prefix and its boundary', () => {
    const plan = planCompaction(conversation(), 1, 1, measure);
    expect(plan).not.toBeNull();
    expect(plan!.throughSeq).toBe(5);
    expect(plan!.messagesToSummarize.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(plan!.tokensBefore).toBeGreaterThan(0);
  });

  it('skips when the prefix is below the minimum compact size', () => {
    expect(planCompaction(conversation(), 1, 1_000, measure)).toBeNull();
  });

  it('keeps runtime-context snapshots out of the summary body', () => {
    const messages = [
      runtimeContext(1, 'workspace snapshot'),
      user(2, 'real request'),
      assistant(3, 'answer'),
      user(4, 'latest request'),
      assistant(5, 'latest answer'),
    ];
    const plan = planCompaction(messages, 1, 1, measure);
    expect(plan!.throughSeq).toBe(3);
    expect(plan!.messagesToSummarize.map((item) => item.seq)).toEqual([2, 3]);
  });
});

describe('renderTranscriptMessages pruning', () => {
  const big = 'x'.repeat(9_000) + '\nfull output: /tmp/spill/session/stdout.log';

  it('replaces oversized old tool results and keeps the spill pointer', async () => {
    const messages = [toolResult(1, 'call-1', big), user(2, 'next turn')];
    const rendered = await renderTranscriptMessages(messages, {
      pruneToolResultsThroughSeq: 1,
      toolResultKeepBytes: 8_192,
    });
    const content = (rendered[0]!.content as Array<{ content?: string }>)[0]!.content ?? '';
    expect(content).toContain('earlier tool result omitted');
    expect(content).toContain('/tmp/spill/session/stdout.log');
  });

  it('leaves results at or after the boundary untouched', async () => {
    const messages = [toolResult(1, 'call-1', big), user(2, 'next turn')];
    const rendered = await renderTranscriptMessages(messages, {
      pruneToolResultsThroughSeq: 0,
      toolResultKeepBytes: 8_192,
    });
    const content = (rendered[0]!.content as Array<{ content?: string }>)[0]!.content ?? '';
    expect(content).toBe(big);
  });
});

function fakeProvider(complete: LlmProvider['complete']): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    stream: async function* () {},
    complete,
  };
}

function fakeStore(appended: unknown[]): TranscriptStore {
  return {
    getOrCreateThread: () => {
      throw new Error('not used');
    },
    getThread: () => undefined,
    append: () => {
      throw new Error('not used');
    },
    list: () => [],
    latestContext: () => null,
    appendCompaction: (input) => {
      appended.push(input);
      return {
        id: 'compaction-1',
        threadId: input.threadId,
        prevId: input.prevId ?? null,
        summary: input.summary,
        throughSeq: input.throughSeq,
        tokensBefore: input.tokensBefore ?? null,
        tokensAfter: input.tokensAfter ?? null,
        createdAt: 1,
      } satisfies NativeCompaction;
    },
    listCompactions: () => [],
  };
}

const settings = {
  enabled: true,
  triggerAt: 0.8,
  keepRecentRatio: 0.4,
  minCompactTokens: 1,
  maxSummaryTokens: 1_024,
  pruneOldToolResults: true,
  toolResultPruneTarget: 0.6,
  toolResultKeepBytes: 8_192,
};

describe('summarizeCompaction', () => {
  it('persists the summary with the previous chain link', async () => {
    const appended: Array<Record<string, unknown>> = [];
    const previous: NativeCompaction = {
      id: 'prev',
      threadId: 'thread-1',
      prevId: null,
      summary: 'older summary',
      throughSeq: 2,
      tokensBefore: 100,
      tokensAfter: 10,
      createdAt: 1,
    };
    const result = await summarizeCompaction({
      transcript: fakeStore(appended),
      threadId: 'thread-1',
      provider: fakeProvider(async () => ({
        text: '  SUMMARY  ',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      })),
      model: 'm',
      plan: {
        throughSeq: 5,
        messagesToSummarize: [user(1, 'old request')],
        tokensBefore: 100,
      },
      previous,
      settings,
      measure,
      signal: new AbortController().signal,
    });

    expect(result!.summary).toBe('SUMMARY');
    expect(appended[0]).toMatchObject({
      prevId: 'prev',
      throughSeq: 5,
      summary: 'SUMMARY',
      tokensBefore: 100,
      tokensAfter: measure('SUMMARY'),
    });
  });

  it('keeps history uncompacted when the provider fails or returns nothing', async () => {
    const appended: unknown[] = [];
    const failing = await summarizeCompaction({
      transcript: fakeStore(appended),
      threadId: 'thread-1',
      provider: fakeProvider(async () => {
        throw new Error('provider down');
      }),
      model: 'm',
      plan: { throughSeq: 5, messagesToSummarize: [user(1, 'old')], tokensBefore: 10 },
      previous: null,
      settings,
      measure,
      signal: new AbortController().signal,
    });
    expect(failing).toBeNull();

    const empty = await summarizeCompaction({
      transcript: fakeStore(appended),
      threadId: 'thread-1',
      provider: fakeProvider(async () => ({
        text: '   ',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      })),
      model: 'm',
      plan: { throughSeq: 5, messagesToSummarize: [user(1, 'old')], tokensBefore: 10 },
      previous: null,
      settings,
      measure,
      signal: new AbortController().signal,
    });
    expect(empty).toBeNull();
    expect(appended).toHaveLength(0);
  });
});
