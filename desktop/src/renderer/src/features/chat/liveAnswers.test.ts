import { describe, expect, it } from 'vitest';
import { findAwaitingAnswer, findLiveAnswer, listLiveAnswers } from './liveAnswers';
import { emptyChat } from '../../store/chat/types';
import type { ChatMessage } from '../../store/chat/types';

const base = () => emptyChat('host::live', 'host');

type Assistant = Extract<ChatMessage, { kind: 'assistant' }>;

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    kind: 'assistant',
    id: 'a1',
    blocks: [{ kind: 'text', text: 'thinking' }],
    usage: null,
    error: null,
    done: false,
    ...overrides,
  };
}

describe('live answers', () => {
  it('finds a room answer in pendingAnswers', () => {
    const state = {
      ...base(),
      pendingAnswers: [{ runId: 'r1', agentId: 'member', message: assistant() }],
    };
    expect(findLiveAnswer(state, 'r1')).toMatchObject({ runId: 'r1', agentId: 'member' });
  });

  it('finds a per-run stream answer through chat.runId', () => {
    const state = { ...base(), runId: 'r2', messages: [assistant({ id: 'a2' })] };
    expect(findLiveAnswer(state, 'r2')?.message.id).toBe('a2');
    expect(listLiveAnswers(state).map((answer) => answer.runId)).toEqual(['r2']);
  });

  it('dedupes a message that already carries the run id', () => {
    const state = {
      ...base(),
      runId: 'r3',
      messages: [assistant({ id: 'a3', runId: 'r3' })],
    };
    expect(listLiveAnswers(state)).toHaveLength(1);
  });

  it('ignores finished messages', () => {
    const state = {
      ...base(),
      runId: 'r4',
      messages: [assistant({ id: 'a4', done: true })],
    };
    expect(findLiveAnswer(state, 'r4')).toBeNull();
    expect(listLiveAnswers(state)).toHaveLength(0);
  });

  it('finds an unanswered question in a per-run live answer', () => {
    const state = {
      ...base(),
      runId: 'r5',
      messages: [
        assistant({
          id: 'a5',
          blocks: [{ kind: 'question', toolUseId: 'q1', questions: [], answered: false }],
        }),
      ],
    };
    expect(findAwaitingAnswer(state)?.runId).toBe('r5');
  });

  it('does not report an answered question', () => {
    const state = {
      ...base(),
      runId: 'r6',
      messages: [
        assistant({
          id: 'a6',
          blocks: [{ kind: 'question', toolUseId: 'q2', questions: [], answered: true }],
        }),
      ],
    };
    expect(findAwaitingAnswer(state)).toBeNull();
  });
});
