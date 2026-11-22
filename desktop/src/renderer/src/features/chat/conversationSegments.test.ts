import { describe, expect, it } from 'vitest';
import { conversationSegments, hasTraceSegments, questionInteractive } from './conversationSegments';
import type { ContentBlock } from '../../store/chat/types';

describe('conversationSegments', () => {
  it('keeps text, questions and notices but hides the execution trace', () => {
    const blocks: ContentBlock[] = [
      { kind: 'thinking', active: false },
      { kind: 'text', text: '最终回答' },
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'ls' },
        result: 'ok',
        isError: false,
        interrupted: false,
        running: false,
      },
      {
        kind: 'question',
        toolUseId: 'q1',
        questions: [],
        answered: false,
        permissionId: 'p1',
      },
      { kind: 'notice', text: '上下文已压缩' },
    ];

    expect(conversationSegments(blocks).map((segment) => segment.kind)).toEqual([
      'text',
      'question',
      'notice',
    ]);
    expect(hasTraceSegments(blocks)).toBe(true);
    expect(hasTraceSegments([{ kind: 'text', text: '只有正文' }])).toBe(false);
  });
});

describe('questionInteractive', () => {
  it('answers only questions from the latest room turn', () => {
    expect(
      questionInteractive({
        index: 4,
        lastUserIndex: 3,
        runTurnId: 'turn-2',
        lastUserTurnId: 'turn-2',
      }),
    ).toBe(true);
    // A slow answer that committed after a newer question still belongs to the
    // old turn, so it must stay read-only.
    expect(
      questionInteractive({
        index: 5,
        lastUserIndex: 3,
        runTurnId: 'turn-1',
        lastUserTurnId: 'turn-2',
      }),
    ).toBe(false);
  });

  it('falls back to position for legacy runs without turnIds', () => {
    expect(
      questionInteractive({ index: 4, lastUserIndex: 3, runTurnId: null, lastUserTurnId: null }),
    ).toBe(true);
    expect(
      questionInteractive({ index: 2, lastUserIndex: 3, runTurnId: null, lastUserTurnId: null }),
    ).toBe(false);
  });

  it('treats a history with no user message as not answerable', () => {
    expect(
      questionInteractive({ index: 0, lastUserIndex: -1, runTurnId: 't', lastUserTurnId: null }),
    ).toBe(false);
  });
});
