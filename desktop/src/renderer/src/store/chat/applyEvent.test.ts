import { describe, expect, it } from 'vitest';
import {
  applyFrame,
  buildAssistantFromEvents,
  finalizeAssistant,
  lastAssistant,
  newAssistant,
  trackContext,
  type FrameState,
} from './applyEvent';
import type { NormalizedEvent, SseFrame } from '../../../../shared/contract';

let counter = 0;
const makeId = (): string => `m${++counter}`;
const frame = (seq: number, event: NormalizedEvent): SseFrame => ({ runId: 'r1', seq, event });

function emptyState(): FrameState {
  return { messages: [newAssistant(makeId())], todos: [], contextUsage: null, terminal: false, terminalSucceeded: false };
}

function run(events: NormalizedEvent[]): FrameState {
  return events.reduce((state, event, i) => applyFrame(state, frame(i + 1, event), makeId), emptyState());
}

describe('invariant 1 — usage is last-value-wins', () => {
  it('keeps the previous usage when a frame carries none', () => {
    const state = run([
      { type: 'usage', usage: { input_tokens: 120, output_tokens: 30 }, costUsd: 0.01 },
      { type: 'usage', usage: {} }, // a transport-error frame with no numbers
    ]);
    expect(lastAssistant(state.messages)?.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.01 });
  });

  it('accepts a later, fuller usage frame', () => {
    const state = run([
      { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'usage', usage: { input_tokens: 2, output_tokens: 9 }, costUsd: 0.5 },
    ]);
    expect(lastAssistant(state.messages)?.usage?.outputTokens).toBe(9);
  });
});

describe('invariant 2 — context occupancy only moves when reported', () => {
  it('ignores frames without contextTokens', () => {
    const withContext = trackContext(null, { type: 'usage', usage: {}, contextTokens: 23_000, contextWindow: null });
    expect(withContext).toEqual({ tokens: 23_000, window: null });

    const unchanged = trackContext(withContext, { type: 'usage', usage: {} });
    expect(unchanged).toBe(withContext);
  });

  it('treats a null window as "capacity unknown" rather than zero', () => {
    expect(trackContext(null, { type: 'usage', usage: {}, contextTokens: 5, contextWindow: null })).toEqual({
      tokens: 5,
      window: null,
    });
  });

  it('survives a reconnect replay that contains no usage frames', () => {
    // The cursor replay can legitimately omit the original usage frames; the
    // store must not reset on that, hence `contextUsage` is only ever replaced
    // by trackContext, never cleared by a frame.
    const state = run([{ type: 'usage', usage: {}, contextTokens: 1_000, contextWindow: 200_000 }]);
    const after = applyFrame(state, frame(2, { type: 'text_delta', delta: 'hi' }), makeId);
    expect(after.contextUsage).toEqual({ tokens: 1_000, window: 200_000 });
  });
});

describe('invariant 4 — interruption is synthesized locally', () => {
  it('closes a still-running tool as interrupted', () => {
    const state = run([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
    const closed = finalizeAssistant(lastAssistant(state.messages)!);
    const block = closed.blocks[0];
    expect(block).toMatchObject({ kind: 'tool', running: false, interrupted: true, isError: false });
  });

  it('does not mark a tool that already has a result', () => {
    const state = run([
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_result', toolUseId: 't1', content: 'ok' },
    ]);
    const closed = finalizeAssistant(lastAssistant(state.messages)!);
    expect(closed.blocks[0]).toMatchObject({ running: false, interrupted: false, result: 'ok' });
  });

  it('is idempotent', () => {
    const state = run([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]);
    const once = finalizeAssistant(lastAssistant(state.messages)!);
    expect(finalizeAssistant(once)).toBe(once);
  });
});

describe('invariant 5 — a succeeded status clears a residual error', () => {
  it('drops a non-terminal error from a run that succeeded', () => {
    const state = run([
      { type: 'error', message: 'model list refresh failed' },
      { type: 'text_delta', delta: 'all good' },
      { type: 'status', label: 'succeeded', terminal: true },
    ]);
    const assistant = lastAssistant(state.messages)!;
    expect(assistant.error).toBeNull();
    expect(assistant.done).toBe(true);
    expect(state.terminalSucceeded).toBe(true);
  });

  it('keeps the error when the run failed', () => {
    const state = run([{ type: 'error', message: 'boom', terminal: true }]);
    expect(lastAssistant(state.messages)?.error).toBe('boom');
  });
});

describe('transcript structure', () => {
  it('routes TodoWrite to the todo list instead of a tool card', () => {
    const state = run([
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'ship it', status: 'in_progress' }] } },
    ]);
    expect(state.todos).toEqual([{ content: 'ship it', status: 'in_progress' }]);
    expect(lastAssistant(state.messages)?.blocks).toEqual([]);
  });

  it('keeps a thinking card whose active state follows the stream', () => {
    const thinking = run([
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'a' },
      { type: 'thinking_delta', delta: 'b' },
    ]);
    expect(lastAssistant(thinking.messages)?.blocks).toEqual([{ kind: 'thinking', active: true }]);

    const answered = run([
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'a' },
      { type: 'text_delta', delta: 'x' },
    ]);
    expect(lastAssistant(answered.messages)?.blocks).toEqual([
      { kind: 'thinking', active: false },
      { kind: 'text', text: 'x' },
    ]);
  });

  it('pairs a tool_result with its tool_use by id', () => {
    const state = run([
      { type: 'tool_use', id: 'a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'b', name: 'Write', input: {} },
      { type: 'tool_result', toolUseId: 'a', content: 'file body' },
    ]);
    const blocks = lastAssistant(state.messages)!.blocks;
    expect(blocks[0]).toMatchObject({ id: 'a', result: 'file body', running: false });
    expect(blocks[1]).toMatchObject({ id: 'b', result: null, running: true });
  });
});

describe('buildAssistantFromEvents (history replay)', () => {
  it('reaches the same visual state as the live stream', () => {
    const events: NormalizedEvent[] = [
      { type: 'status', label: 'starting', runtime: 'claude' },
      { type: 'thinking_delta', delta: 'hmm' },
      { type: 'text_delta', delta: 'hello' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'ok' },
      { type: 'usage', usage: { input_tokens: 5, output_tokens: 2 } },
      { type: 'status', label: 'succeeded', terminal: true },
    ];
    const replayed = buildAssistantFromEvents(events.map((event, i) => frame(i + 1, event)), makeId);
    const live = lastAssistant(run(events).messages)!;

    // Message ids are generated per call, so compare everything else.
    expect({ ...replayed.assistant, id: 'x' }).toEqual({ ...live, id: 'x' });
    expect(replayed.assistant.done).toBe(true);
  });

  it('skips permission frames, which are transient', () => {
    const replayed = buildAssistantFromEvents(
      [frame(1, { type: 'permission_request', permissionId: 'p1', toolName: 'Bash', toolInput: {}, status: 'pending' })],
      makeId,
    );
    expect(replayed.assistant.blocks).toEqual([]);
  });

  it('feeds context tracking so the ring is populated without a live run', () => {
    const replayed = buildAssistantFromEvents(
      [frame(1, { type: 'usage', usage: {}, contextTokens: 12_000, contextWindow: 200_000 })],
      makeId,
    );
    expect(replayed.contextUsage).toEqual({ tokens: 12_000, window: 200_000 });
  });
});
