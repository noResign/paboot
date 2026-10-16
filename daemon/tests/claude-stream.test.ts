import { describe, expect, it } from 'vitest';
import { createClaudeStreamParser } from '../src/runtimes/claude/stream';
import type { NormalizedEvent } from '../src/types/api';

function parse(lines: string[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const parser = createClaudeStreamParser((ev) => events.push(ev));
  for (const line of lines) parser.feed(`${line}\n`);
  parser.flush();
  return events;
}

describe('createClaudeStreamParser', () => {
  it('emits status from the system init frame', () => {
    const events = parse([
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', session_id: 'abc-123' }),
    ]);
    expect(events[0]).toMatchObject({
      type: 'status',
      label: 'initializing',
      model: 'claude-sonnet-4-5',
      sessionId: 'abc-123',
    });
  });

  it('streams text_delta events from stream_event deltas', () => {
    const events = parse([
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' }, ttft_ms: 100 } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    ]);
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('hello world');
  });

  it('assembles tool_use input across input_json_delta chunks', () => {
    const events = parse([
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    ]);
    const toolUse = events.find((e): e is Extract<NormalizedEvent, { type: 'tool_use' }> => e.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } });
  });

  it('does not duplicate text already streamed via deltas', () => {
    const events = parse([
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'once' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'once' }] } }),
    ]);
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('once');
  });

  it('emits turn_end only for the main turn (parent_tool_use_id null)', () => {
    const events = parse([
      JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [] } }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'parent-1',
        message: { id: 'sub-1', stop_reason: 'end_turn', content: [] },
      }),
    ]);
    const turns = events.filter((e) => e.type === 'turn_end');
    expect(turns).toHaveLength(1);
  });

  it('falls back to the assistant wrapper when no deltas were streamed', () => {
    const events = parse([
      JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'full body' }] } }),
    ]);
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('full body');
  });

  it('emits turn_end from the result frame (assistant stop_reason is null in recent Claude)', () => {
    const events = parse([
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', stop_reason: 'end_turn', usage: {} }),
    ]);
    const turns = events.filter((e) => e.type === 'turn_end');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ type: 'turn_end', stopReason: 'end_turn' });
  });

  it('reports context occupancy from the three disjoint input buckets', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          stop_reason: null,
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 30 },
        },
      }),
    ]);
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(1);
    // `usage: null` on purpose: the client's parseUsage returns null, so the
    // per-run usage line keeps whatever it had and never sees this figure.
    expect(usages[0]).toEqual({ type: 'usage', usage: null, contextTokens: 5300, contextWindow: null });
  });

  it('skips sub-agent frames and repeats, and repeats the value on the result frame', () => {
    const frame = (id: string, used: number, parent?: string) => JSON.stringify({
      type: 'assistant',
      ...(parent ? { parent_tool_use_id: parent } : {}),
      message: {
        id,
        stop_reason: null,
        content: [],
        usage: { input_tokens: used, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 1 },
      },
    });
    const events = parse([
      frame('m1', 100),
      frame('m1', 100),            // same message arriving twice -> one frame
      frame('sub', 90_000, 'p1'),  // a sub-agent has its own window
      frame('m2', 300),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }),
    ]);
    // Context-only frames are the ones that carry `usage: null`; the result
    // frame repeats the value but is asserted separately below.
    const contexts = events.filter(
      (e): e is Extract<NormalizedEvent, { type: 'usage' }> =>
        e.type === 'usage' && e.usage === null && typeof e.contextTokens === 'number',
    );
    expect(contexts.map((e) => e.contextTokens)).toEqual([4100, 4300]);
    // History rebuild lands on the last frame, so it has to be self-contained.
    const result = events.find((e) => e.type === 'usage' && e.usage !== null);
    expect(result).toMatchObject({ type: 'usage', contextTokens: 4300, contextWindow: null });
  });

  it('adopts message_start usage when the assistant frame omits it', () => {
    // Some CLI builds report usage only in the raw `message_start` event. The
    // value is adopted at the assistant frame, because that is the first point
    // where a main-turn message can be told from a sub-agent's.
    const events = parse([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'm1',
            usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
          },
        },
      }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [] } }),
    ]);
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', usage: null, contextTokens: 5300, contextWindow: null },
    ]);
  });

  it('ignores a sub-agent message_start, whose usage describes its own window', () => {
    const usage = { input_tokens: 90_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const events = parse([
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'sub', usage } } }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'p1',
        message: { id: 'sub', stop_reason: 'end_turn', content: [] },
      }),
    ]);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(0);
  });

  it('never mistakes the result frame aggregate for occupancy', () => {
    // `usage` on the result frame is the whole query's total (it sits next to
    // num_turns / modelUsage): every tool call inside the run is another request.
    const events = parse([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        stop_reason: 'end_turn',
        num_turns: 30,
        usage: { input_tokens: 400_000, cache_read_input_tokens: 9_000_000, cache_creation_input_tokens: 0, output_tokens: 5 },
      }),
    ]);
    const result = events.find((e): e is Extract<NormalizedEvent, { type: 'usage' }> => e.type === 'usage' && e.usage !== null);
    // It is still forwarded — it carries the stop reason and cost — but claiming
    // 9.4M tokens of context is exactly the bug this guards.
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('contextTokens');
  });
});
