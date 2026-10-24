import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../src/types/api';
import { createCodexStreamMapper, readCodexApproval } from '../src/runtimes/codex/map';

/** Collect everything the mapper emits for a list of notifications. */
function collect(notifications: Array<[string, unknown]>): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const mapper = createCodexStreamMapper((ev) => events.push(ev));
  for (const [method, params] of notifications) mapper.onNotification(method, params);
  return events;
}

describe('codex item → tool_result', () => {
  it('reports a declined file change as an error, not a success', () => {
    const events = collect([
      ['item/started', { item: { id: 'edit-1', type: 'fileChange', status: 'inProgress', changes: [] } }],
      ['item/completed', {
        item: { id: 'edit-1', type: 'fileChange', status: 'declined', changes: [{ path: '/a.ts', diff: '-old\n+new' }] },
      }],
    ]);
    const result = events.find((ev) => ev.type === 'tool_result');
    // The operator refused this edit — a success card would show the diff as applied.
    expect(result).toMatchObject({ type: 'tool_result', toolUseId: 'edit-1', isError: true });
  });

  it('keeps a completed file change successful', () => {
    const events = collect([
      ['item/completed', { item: { id: 'edit-2', type: 'fileChange', status: 'completed', changes: [] } }],
    ]);
    expect(events.find((ev) => ev.type === 'tool_result')).toMatchObject({ isError: false });
  });

  it('separates terminal writes from shell commands so grants cannot cross over', () => {
    expect(readCodexApproval('item/commandExecution/requestApproval', { command: 'ls', kind: 'command' }))
      .toMatchObject({ toolName: 'Bash' });
    expect(readCodexApproval('item/commandExecution/requestApproval', { kind: 'writeStdin' }))
      .toMatchObject({ toolName: 'TerminalInput' });
  });
});

describe('codex error notifications', () => {
  it('forwards the usage-limit error and its machine code', () => {
    // Without this branch a rate-limited account looks like a run that simply
    // never says anything (which is how it looked the first time around).
    const events = collect([
      ['error', {
        error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
        threadId: 't-1',
        turnId: 'u-1',
        willRetry: false,
      }],
    ]);
    expect(events).toEqual([
      { type: 'error', code: 'usageLimitExceeded', message: 'You have hit your usage limit.' },
    ]);
  });

  it('keeps the code of the wrapped CodexErrorInfo variants', () => {
    const events = collect([
      ['turn/completed', {
        turn: {
          id: 'u-1',
          status: 'failed',
          error: { message: 'stream died', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
        },
      }],
    ]);
    expect(events.find((ev) => ev.type === 'error')).toMatchObject({
      type: 'error',
      code: 'responseStreamDisconnected',
      message: 'stream died',
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'failed' });
  });

  it('still emits an error when the provider gave no code', () => {
    const events = collect([['error', { error: { message: 'something broke' }, threadId: 't', turnId: 'u', willRetry: true }]]);
    expect(events[0]).toEqual({ type: 'error', message: 'something broke' });
  });
});

describe('codex permission profile → approval card', () => {
  const card = (entries: unknown[]) => readCodexApproval('item/permissions/requestApproval', {
    itemId: 'p-1',
    permissions: { fileSystem: { entries } },
  })?.toolInput as { permissions: { fileSystem: { read: string[]; write: string[] } } };

  it('expands literal and glob entries', () => {
    const { permissions } = card([
      { access: 'read', path: { type: 'path', path: '/srv/data' } },
      { access: 'write', path: { type: 'glob_pattern', pattern: '/srv/**/*.log' } },
    ]);
    expect(permissions.fileSystem.read).toEqual(['/srv/data']);
    expect(permissions.fileSystem.write).toEqual(['/srv/**/*.log']);
  });

  it('shows special paths too, so the card never lists less than it grants', () => {
    const { permissions } = card([
      { access: 'read', path: { type: 'special', value: { kind: 'project_roots' } } },
      { access: 'read', path: { type: 'special', value: { kind: 'tmpdir' } } },
      { access: 'write', path: { type: 'special', value: { kind: 'kind-nobody-has-seen' } } },
    ]);
    expect(permissions.fileSystem.read).toEqual(['项目根目录', '系统临时目录']);
    expect(permissions.fileSystem.write).toEqual(['特殊路径（kind-nobody-has-seen）']);
  });

  it('leaves deny entries out — they take access away, they do not grant it', () => {
    const { permissions } = card([
      { access: 'deny', path: { type: 'path', path: '/etc/shadow' } },
      { access: 'read', path: { type: 'path', path: '/srv/data' } },
    ]);
    expect(permissions.fileSystem.read).toEqual(['/srv/data']);
    expect(permissions.fileSystem.write).toEqual([]);
  });
});

describe('Codex per-run token usage', () => {
  const counts = (input: number, output: number) => ({ inputTokens: input, outputTokens: output });
  const update = (total: [number, number], last: [number, number]) => ({
    tokenUsage: { total: counts(...total), last: counts(...last) },
  });

  it('counts every model call but only reports the total once the turn ends', () => {
    const events: NormalizedEvent[] = [];
    const mapper = createCodexStreamMapper(ev => events.push(ev));
    mapper.beginTurn();
    mapper.onNotification('thread/tokenUsage/updated', update([100, 20], [100, 20]));
    mapper.onNotification('thread/tokenUsage/updated', update([250, 50], [150, 30]));
    mapper.onNotification('thread/tokenUsage/updated', update([250, 50], [150, 30]));

    // Mid-run frames must not carry a usage line, or the phone shows the number
    // ticking up while the turn is still running (Claude shows it only at the end).
    const usageOf = (ev: NormalizedEvent) => (ev as { usage?: unknown }).usage;
    const midRun = events.filter(ev => ev.type === 'usage');
    expect(midRun.length).toBeGreaterThan(0);
    expect(midRun.every(ev => usageOf(ev) === null)).toBe(true);

    mapper.onNotification('turn/completed', { turn: { status: 'completed' } });
    const finals = events.filter(ev => ev.type === 'usage' && usageOf(ev) !== null);
    expect(finals.map(usageOf)).toEqual([{ input_tokens: 250, output_tokens: 50 }]);
  });

  it.each([true, false])('excludes previous turns on resume (initial snapshot: %s)', snapshot => {
    const events: NormalizedEvent[] = [];
    const mapper = createCodexStreamMapper(ev => events.push(ev), { resumed: true });
    if (snapshot) mapper.onNotification('thread/tokenUsage/updated', update([1000, 200], [300, 60]));
    expect(events).toEqual([]);
    mapper.beginTurn();
    mapper.onNotification('thread/tokenUsage/updated', update([1100, 220], [100, 20]));
    mapper.onNotification('thread/tokenUsage/updated', update([1250, 250], [150, 30]));
    mapper.onNotification('turn/completed', { turn: { status: 'completed' } });
    const finals = events.filter(ev => ev.type === 'usage' && (ev as { usage?: unknown }).usage !== null);
    expect(finals.at(-1)).toMatchObject({ type: 'usage', usage: { input_tokens: 250, output_tokens: 50 } });
  });
});

describe('Codex reasoning', () => {
  it('fills the thinking card from the completed item when nothing streamed', () => {
    const events = collect([
      ['item/started', { item: { id: 'rs-1', type: 'reasoning', summary: [], content: [] } }],
      ['item/completed', { item: { id: 'rs-1', type: 'reasoning', summary: ['**Identifying requirement**'], content: [] } }],
    ]);
    expect(events.filter(ev => ev.type === 'thinking_delta')).toEqual([
      { type: 'thinking_delta', delta: '**Identifying requirement**' },
    ]);
  });

  it('does not repeat a summary that already streamed as deltas', () => {
    const events = collect([
      ['item/reasoning/summaryTextDelta', { itemId: 'rs-2', delta: 'part one ' }],
      ['item/completed', { item: { id: 'rs-2', type: 'reasoning', summary: ['part one and the rest'] } }],
    ]);
    const deltas = events.filter(ev => ev.type === 'thinking_delta');
    expect(deltas.map(ev => (ev as { delta: string }).delta)).toEqual(['part one ']);
  });

  it('falls back to raw reasoning content when there is no summary', () => {
    const events = collect([
      ['item/completed', { item: { id: 'rs-3', type: 'reasoning', summary: [], content: ['raw thought'] } }],
    ]);
    expect(events.find(ev => ev.type === 'thinking_delta')).toMatchObject({ delta: 'raw thought' });
  });

  it('stays silent for an empty reasoning item (no card with nothing in it)', () => {
    const events = collect([
      ['item/started', { item: { id: 'rs-4', type: 'reasoning', summary: [], content: [] } }],
      ['item/reasoning/summaryPartAdded', { itemId: 'rs-4' }],
      ['item/completed', { item: { id: 'rs-4', type: 'reasoning', summary: [], content: [] } }],
    ]);
    expect(events.filter(ev => ev.type === 'thinking_delta')).toEqual([]);
    expect(events.filter(ev => ev.type === 'thinking_start')).toEqual([]);
  });
});

describe('Codex context window occupancy', () => {
  /** One `thread/tokenUsage/updated`, with the window when the server sends it. */
  const snapshot = (
    total: [number, number],
    last: [number, number],
    modelContextWindow?: number | null,
  ) => ({
    tokenUsage: {
      total: { inputTokens: total[0], outputTokens: total[1] },
      last: { inputTokens: last[0], outputTokens: last[1] },
      ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
    },
  });

  const run = (notifications: Array<[string, unknown]>): NormalizedEvent[] => {
    const events: NormalizedEvent[] = [];
    const mapper = createCodexStreamMapper(ev => events.push(ev));
    mapper.beginTurn();
    for (const [method, params] of notifications) mapper.onNotification(method, params);
    return events;
  };

  it('reports the last request input against the window, beside the accumulated total', () => {
    const events = run([
      ['thread/tokenUsage/updated', snapshot([45_200, 900], [45_200, 900], 168_000)],
      ['turn/completed', { turn: { status: 'completed' } }],
    ]);
    const usages = events.filter(ev => ev.type === 'usage');
    // Mid-run: context only, no usage line yet.
    expect(usages.at(0)).toEqual({ type: 'usage', usage: null, contextTokens: 45_200, contextWindow: 168_000 });
    // Turn end: the run's total, carrying the last known occupancy with it.
    expect(usages.at(-1)).toEqual({
      type: 'usage',
      usage: { input_tokens: 45_200, output_tokens: 900 },
      durationMs: null,
      stopReason: 'completed',
      contextTokens: 45_200,
      contextWindow: 168_000,
    });
  });

  it('has no denominator when the provider omits the window', () => {
    const events = run([['thread/tokenUsage/updated', snapshot([45_200, 900], [45_200, 900], null)]]);
    expect(events.at(-1)).toMatchObject({ contextTokens: 45_200, contextWindow: null });
  });

  it('adds no context fields when the snapshot carries no last input', () => {
    const events = run([
      ['thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10, outputTokens: 1 }, last: {} } }],
      ['turn/completed', { turn: { status: 'completed' } }],
    ]);
    // Nothing to report mid-run (no occupancy available), so the only usage
    // frame is the final total — and it must not invent context fields.
    const finals = events.filter(ev => ev.type === 'usage' && (ev as { usage?: unknown }).usage !== null);
    const last = finals.at(-1) as Extract<NormalizedEvent, { type: 'usage' }>;
    expect(last.usage).toEqual({ input_tokens: 10, output_tokens: 1 });
    expect('contextTokens' in last).toBe(false);
    expect('contextWindow' in last).toBe(false);
  });

  it('carries the last occupancy onto the frame that closes the turn', () => {
    const events = run([
      ['thread/tokenUsage/updated', snapshot([100, 10], [100, 10], 168_000)],
      ['turn/completed', { turn: { status: 'completed', durationMs: 12 } }],
    ]);
    expect(events.at(-2)).toMatchObject({
      type: 'usage',
      stopReason: 'completed',
      contextTokens: 100,
      contextWindow: 168_000,
    });
  });
});
