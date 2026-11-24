import { describe, expect, it } from 'vitest';
import {
  findAwaitingAnswer,
  findLiveAnswer,
  listLiveAnswers,
  traceTargetOnJump,
} from './liveAnswers';
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

describe('trace target on jump', () => {
  const withLive = (runId: string) => ({
    ...base(),
    pendingAnswers: [{ runId, agentId: 'member', message: assistant() }],
  });

  it('leaves a closed pane closed, even when work is live', () => {
    expect(traceTargetOnJump(withLive('r2'), null)).toBeNull();
  });

  it('keeps a pane whose run is still live', () => {
    expect(traceTargetOnJump(withLive('r1'), 'r1')).toBe('r1');
  });

  it('keeps the open run even when other agents are live too', () => {
    const state = {
      ...base(),
      pendingAnswers: [
        { runId: 'r1', agentId: 'a', message: assistant() },
        { runId: 'r2', agentId: 'b', message: assistant() },
      ],
    };
    expect(traceTargetOnJump(state, 'r1')).toBe('r1');
  });

  it('retargets a stale pane when exactly one agent is live', () => {
    // What the user saw: a finished agent's trace while another one answered.
    expect(traceTargetOnJump(withLive('r2'), 'r1')).toBe('r2');
  });

  it('closes a stale pane when several agents are live', () => {
    // Following one of them blindly would hide the rest; the tab's live cards
    // are the chooser.
    const state = {
      ...base(),
      pendingAnswers: [
        { runId: 'r2', agentId: 'a', message: assistant() },
        { runId: 'r3', agentId: 'b', message: assistant() },
      ],
    };
    expect(traceTargetOnJump(state, 'r1')).toBeNull();
  });

  it('closes a stale pane when nothing is live', () => {
    expect(traceTargetOnJump(base(), 'r1')).toBeNull();
  });
});
