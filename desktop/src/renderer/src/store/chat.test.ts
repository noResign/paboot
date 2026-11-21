import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({
  api: { session: vi.fn(), updateSessionModel: vi.fn() },
  connectionApi: { streamStart: vi.fn() },
}));
vi.mock('./sessions', () => ({ useSessions: { getState: () => ({ refreshCurrent: vi.fn() }) } }));
vi.mock('../notify/notifier', () => ({ notifyRunFinished: vi.fn(), notifyPermission: vi.fn(), closePermissionNotification: vi.fn() }));
import { api, connectionApi } from '../ipc/client';
import { reduceRoomFrames, useChat } from './chat';
import { emptyChat } from './chat/types';
import type { RunDto } from '../../../shared/contract';

const run = { id: 'r', status: 'succeeded', checkpoint: { status: 'complete', preRef: 'pre', postRef: 'post' } } as RunDto;
const key = 'host::s';
beforeEach(() => {
  vi.clearAllMocks();
  useChat.setState({
    activeKey: key, streamKeys: { stream: key }, failedIds: [],
    byKey: { [key]: { ...emptyChat(key, 'host'), sessionId: 's', streamId: 'stream', runId: 'r', phase: 'live',
      messages: [{ kind: 'user', id: 'u', text: 'hello', runId: 'r' }] } },
  });
});

describe('model selection before the session exists', () => {
  const newKey = 'host::new';

  beforeEach(() => {
    useChat.setState({
      activeKey: newKey,
      streamKeys: {},
      byKey: {
        [newKey]: {
          ...emptyChat(newKey, 'host'),
          runtime: 'builtin',
          pendingNew: { runtime: 'builtin', workspaceId: 'w', permissionMode: 'ask' },
        },
      },
    });
  });

  it('keeps the choice in state instead of calling the session endpoint', async () => {
    await useChat.getState().setSessionSelection('p:m', { reasoningEffort: 'high' });
    const chat = useChat.getState().byKey[newKey]!;
    expect(chat.model).toBe('p:m');
    expect(chat.modelParameters).toEqual({ reasoningEffort: 'high' });
    expect(api.updateSessionModel).not.toHaveBeenCalled();
  });

  it('sends the choice with the first chat request, which creates the session', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true, streamId: 's1' } as never);
    await useChat.getState().setSessionSelection('p:m', { reasoningEffort: 'high' });
    await useChat.getState().send('hi');

    const spec = vi.mocked(connectionApi.streamStart).mock.calls[0]![0];
    expect(spec).toMatchObject({
      kind: 'chat',
      sessionId: null,
      model: 'p:m',
      modelParameters: { reasoningEffort: 'high' },
    });
  });
});

describe('permission mode before the session exists', () => {
  const newKey = 'host::new';

  beforeEach(() => {
    useChat.setState({
      activeKey: newKey,
      streamKeys: {},
      byKey: {
        [newKey]: {
          ...emptyChat(newKey, 'host'),
          runtime: 'builtin',
          pendingNew: { runtime: 'builtin', workspaceId: 'w', permissionMode: 'ask' },
        },
      },
    });
  });

  // `send` reads the creation parameters from `pendingNew`, so a mode picked on
  // the pending page has to land there too — patching only the visible field
  // would show a mode the first run does not use.
  it('updates the creation parameter, not just the visible one', () => {
    useChat.getState().setPermissionMode('acceptEdits');
    const chat = useChat.getState().byKey[newKey]!;
    expect(chat.permissionMode).toBe('acceptEdits');
    expect(chat.pendingNew?.permissionMode).toBe('acceptEdits');
  });

  it('carries the mode on the first chat request', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true, streamId: 's1' } as never);
    useChat.getState().setPermissionMode('bypass');
    await useChat.getState().send('hi');

    const spec = vi.mocked(connectionApi.streamStart).mock.calls[0]![0];
    expect(spec).toMatchObject({ sessionId: null, permissionMode: 'bypass' });
  });

  it('leaves an existing session without creation parameters', () => {
    const chat = { ...emptyChat(newKey, 'host'), sessionId: 's' };
    useChat.setState({ byKey: { [newKey]: chat } });
    useChat.getState().setPermissionMode('ask');
    expect(useChat.getState().byKey[newKey]!.pendingNew).toBeNull();
  });
});

describe('title sync', () => {
  it('renames the open chat in place', () => {
    useChat.getState().patchTitle('host', 's', '新名字');
    expect(useChat.getState().byKey[key]!.title).toBe('新名字');
  });
});

describe('finished run metadata', () => {
  it('refreshes checkpoints without reopening or replacing the transcript', async () => {
    vi.mocked(api.session).mockResolvedValue({ ok: true, status: 200, data: { runs: [run] } } as never);
    useChat.getState().applyStreamEvent({ streamId: 'stream', kind: 'done', outcome: 'finished', httpCode: null, apiCode: null, message: null });
    await vi.waitFor(() => expect(useChat.getState().byKey[key]!.runs).toEqual([run]));
    expect(api.session).toHaveBeenCalledWith('s');
    expect(useChat.getState().byKey[key]!.messages).toEqual([{ kind: 'user', id: 'u', text: 'hello', runId: 'r' }]);
    expect(useChat.getState().byKey[key]!.phase).toBe('idle');
  });

  it('does not overwrite a reopened chat with an older response', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api.session).mockReturnValue(new Promise((done) => { resolve = done; }) as never);
    useChat.getState().applyStreamEvent({ streamId: 'stream', kind: 'done', outcome: 'finished', httpCode: null, apiCode: null, message: null });
    const newer = { ...emptyChat(key, 'host'), sessionId: 's', runs: [{ ...run, id: 'newer' }] };
    useChat.setState({ byKey: { [key]: newer } });
    resolve({ ok: true, status: 200, data: { runs: [run] } });
    await new Promise((done) => setImmediate(done));
    expect(useChat.getState().byKey[key]).toBe(newer);
  });
});

describe('session watch hints for a run already on screen', () => {
  // The daemon publishes `run_started` / `run_finished` for every run, including
  // the one this client is streaming. The terminal hint can land after `done`
  // cleared `streamId` and before the refetched `runs` list arrives, which is
  // exactly when "is it in `runs`?" answers "no" — and the prompt got appended a
  // second time, duplicating the user bubble and replaying the whole reply.
  //
  // The condition is the transcript itself: a rendered run has a user message
  // carrying its id (stamped from the first streamed frame, and by the rebuild).
  it('does not append a finished run that this client streamed itself', () => {
    useChat.setState({
      activeKey: key,
      streamKeys: { watch: key },
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's',
          // The user message carries the run id, exactly as `reduceFrames` stamps it.
          messages: [{ kind: 'user', id: 'u', text: 'hello', runId: 'r' }],
          // `done` already closed the stream; `runs` is still stale.
          streamId: null,
          sessionStreamId: 'watch',
          runs: [],
        },
      },
    });

    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: {
        type: 'run_finished',
        sessionId: 's',
        run: { id: 'r', prompt: 'hello', startedAt: 1, attachmentIds: [], status: 'succeeded' },
      },
    } as never);

    expect(useChat.getState().byKey[key]!.messages).toEqual([
      { kind: 'user', id: 'u', text: 'hello', runId: 'r' },
    ]);
  });

  it('still appends a run started on another device', () => {
    useChat.setState({
      activeKey: key,
      streamKeys: { watch: key },
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's',
          streamId: null,
          sessionStreamId: 'watch',
        },
      },
    });

    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: {
        type: 'run_started',
        sessionId: 's',
        run: { id: 'other', prompt: 'from phone', startedAt: 1, attachmentIds: [], status: 'running' },
      },
    } as never);

    const messages = useChat.getState().byKey[key]!.messages;
    expect(messages[0]).toMatchObject({ kind: 'user', text: 'from phone', runId: 'other' });
  });

  // Reopening a session empties `messages` until the rebuild lands, so a hint in
  // that window has nothing to check against and would append a bubble the
  // rebuild immediately re-orders.
  it('ignores hints while history is loading', () => {
    useChat.setState({
      activeKey: key,
      streamKeys: { watch: key },
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's',
          historyLoading: true,
          streamId: null,
          sessionStreamId: 'watch',
        },
      },
    });

    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: {
        type: 'run_finished',
        sessionId: 's',
        run: { id: 'r', prompt: 'hello', startedAt: 1, attachmentIds: [], status: 'succeeded' },
      },
    } as never);

    expect(useChat.getState().byKey[key]!.messages).toEqual([]);
  });

  // After a reload the transcript is the only memory: rebuilt history stamps each
  // user message with its run id, so "already on screen" still answers true.
  it('does not re-append a prompt that is already on screen', () => {
    useChat.setState({
      activeKey: key,
      streamKeys: { watch: key },
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's',
          streamId: null,
          sessionStreamId: 'watch',
          messages: [{ kind: 'user', id: 'u', text: 'hello', runId: 'r' }],
        },
      },
    });

    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: {
        type: 'run_finished',
        sessionId: 's',
        run: { id: 'r', prompt: 'hello', startedAt: 1, attachmentIds: [], status: 'succeeded' },
      },
    } as never);

    expect(useChat.getState().byKey[key]!.messages).toHaveLength(1);
  });
});

describe('room stream reducer', () => {
  const frame = (runId: string, agentId: string | null, seq: number, event: unknown) =>
    ({ runId, seq, agentId, event }) as never;

  it('keeps one card per run when several agents stream at once', () => {
    const base = emptyChat('host::room', 'host');
    const next = reduceRoomFrames(base, [
      frame('r1', 'a1', 1, { type: 'status', label: 'starting' }),
      frame('r2', 'a2', 1, { type: 'status', label: 'starting' }),
      frame('r1', 'a1', 2, { type: 'text_delta', delta: '审阅说' }),
      frame('r2', 'a2', 2, { type: 'text_delta', delta: '性能说' }),
      frame('r1', 'a1', 3, { type: 'text_delta', delta: '完了' }),
      frame('r1', 'a1', 4, { type: 'status', label: 'succeeded', terminal: true }),
      frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true }),
    ]);

    const answers = next.messages.filter((message) => message.kind === 'assistant');
    expect(answers).toHaveLength(2);

    const first = answers.find((message) => message.kind === 'assistant' && message.runId === 'r1')!;
    const second = answers.find((message) => message.kind === 'assistant' && message.runId === 'r2')!;
    expect(first.kind === 'assistant' && first.agentId).toBe('a1');
    expect(second.kind === 'assistant' && second.agentId).toBe('a2');
    const text = (message: typeof first): string =>
      message.kind === 'assistant'
        ? message.blocks
            .filter((block) => block.kind === 'text')
            .map((block) => (block.kind === 'text' ? block.text : ''))
            .join('')
        : '';
    expect(text(first)).toBe('审阅说完了');
    expect(text(second)).toBe('性能说');
    expect(first.kind === 'assistant' && first.done).toBe(true);
    expect(second.kind === 'assistant' && second.done).toBe(true);
  });

  it('enqueues permission requests without inventing an answer card', () => {
    const base = emptyChat('host::room', 'host');
    const next = reduceRoomFrames(base, [
      frame('r1', 'a1', 1, {
        type: 'permission_request',
        permissionId: 'p1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        status: 'pending',
      }),
    ]);

    expect(next.messages).toHaveLength(0);
    const pending = [next.permissions.active, ...next.permissions.queue].filter(Boolean);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runId).toBe('r1');
  });
});
