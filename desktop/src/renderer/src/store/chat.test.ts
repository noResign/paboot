import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({
  api: { session: vi.fn(), updateSessionModel: vi.fn(), sendTurn: vi.fn(), sessionAgents: vi.fn() },
  connectionApi: { streamStart: vi.fn() },
}));
vi.mock('./sessions', () => ({ useSessions: { getState: () => ({ refreshCurrent: vi.fn() }) } }));
vi.mock('../notify/notifier', () => ({ notifyRunFinished: vi.fn(), notifyPermission: vi.fn(), closePermissionNotification: vi.fn() }));
import { api, connectionApi } from '../ipc/client';
import { reduceRoomFrames, useChat } from './chat';
import { emptyChat } from './chat/types';
import type { ChatMessage } from './chat/types';
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

  it('keeps answers in the pending area until their run commits', () => {
    const base = emptyChat('host::room', 'host');
    const streaming = reduceRoomFrames(base, [
      frame('r1', 'a1', 1, { type: 'status', label: 'starting' }),
      frame('r2', 'a2', 1, { type: 'status', label: 'starting' }),
      frame('r1', 'a1', 2, { type: 'text_delta', delta: '审阅说' }),
      frame('r2', 'a2', 2, { type: 'text_delta', delta: '性能说' }),
      frame('r1', 'a1', 3, { type: 'text_delta', delta: '完了' }),
    ]);

    // While both are still running, the timeline must not grow.
    expect(streaming.messages).toHaveLength(0);
    expect(streaming.pendingAnswers.map((answer) => answer.runId)).toEqual(['r1', 'r2']);

    const text = (message: ChatMessage): string =>
      message.kind === 'assistant'
        ? message.blocks.map((block) => (block.kind === 'text' ? block.text : '')).join('')
        : '';
    expect(text(streaming.pendingAnswers[0]!.message)).toBe('审阅说完了');
    expect(text(streaming.pendingAnswers[1]!.message)).toBe('性能说');

    // r2 finishes first: it commits first, even though r1 started first.
    const next = reduceRoomFrames(streaming, [
      frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true }),
      frame('r1', 'a1', 4, { type: 'status', label: 'succeeded', terminal: true }),
    ]);
    expect(next.pendingAnswers).toHaveLength(0);
    const answers = next.messages.filter((message) => message.kind === 'assistant');
    expect(
      answers.map((message) => (message.kind === 'assistant' ? message.runId : null)),
    ).toEqual(['r2', 'r1']);
    expect(answers.map(text)).toEqual(['性能说', '审阅说完了']);
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

describe('room turns', () => {
  const roomKey = 'host::turn';
  beforeEach(() => {
    vi.mocked(connectionApi.streamStart).mockReset();
    vi.mocked(api.sendTurn).mockReset();
    useChat.setState({
      activeKey: roomKey,
      streamKeys: {},
      failedIds: [],
      byKey: { [roomKey]: { ...emptyChat(roomKey, 'host'), sessionId: 's-turn' } },
    });
  });

  it('does not send when the room stream cannot be opened', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({
      ok: false,
      httpCode: 500,
      apiCode: null,
      message: 'boom',
    } as never);

    await useChat.getState().sendTurn('hi', []);

    expect(api.sendTurn).not.toHaveBeenCalled();
    const chat = useChat.getState().byKey[roomKey]!;
    expect(chat.error).toContain('房间流');
    expect(chat.messages).toHaveLength(0);
  });

  it('stamps the turn onto the question so hints cannot duplicate it', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't1', tasks: [] },
    } as never);

    await useChat.getState().sendTurn('hi', []);

    expect(api.sendTurn).toHaveBeenCalledTimes(1);
    const chat = useChat.getState().byKey[roomKey]!;
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ kind: 'user', text: 'hi', turnId: 't1' });
    expect(chat.roomStreamId).toBeTruthy();
  });
});

describe('double submit', () => {
  const roomKey = 'host::double';
  beforeEach(() => {
    vi.mocked(connectionApi.streamStart).mockReset();
    vi.mocked(api.sendTurn).mockReset();
    useChat.setState({
      activeKey: roomKey,
      streamKeys: {},
      failedIds: [],
      byKey: { [roomKey]: { ...emptyChat(roomKey, 'host'), sessionId: 's-double' } },
    });
  });

  it('ignores a second send while the first turn request is in flight', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true } as never);
    let release!: (value: unknown) => void;
    vi.mocked(api.sendTurn).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );

    const first = useChat.getState().sendTurn('hi', []);
    await vi.waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
    await useChat.getState().sendTurn('hi', []);
    expect(api.sendTurn).toHaveBeenCalledTimes(1);

    release({ ok: true, status: 202, data: { turnId: 't1', tasks: [] } });
    await first;
    expect(useChat.getState().byKey[roomKey]!.messages).toHaveLength(1);
  });
});

describe('leader streaming', () => {
  const frame = (runId: string, agentId: string | null, seq: number, event: unknown) =>
    ({ runId, seq, agentId, event }) as never;

  it('streams the leader in place and holds other agents until they commit', () => {
    const base = { ...emptyChat('host::leader', 'host'), leaderAgentId: 'a1' };
    const streaming = reduceRoomFrames(base, [
      frame('r1', 'a1', 1, { type: 'status', label: 'starting' }),
      frame('r2', 'a2', 1, { type: 'status', label: 'starting' }),
      frame('r1', 'a1', 2, { type: 'text_delta', delta: '主答' }),
      frame('r2', 'a2', 2, { type: 'text_delta', delta: '补充' }),
    ]);

    const live = streaming.messages.filter((message) => message.kind === 'assistant');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: 'assistant', runId: 'r1', done: false });
    expect(streaming.pendingAnswers.map((answer) => answer.runId)).toEqual(['r2']);

    const next = reduceRoomFrames(streaming, [
      frame('r1', 'a1', 3, { type: 'status', label: 'succeeded', terminal: true }),
      frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true }),
    ]);
    expect(next.pendingAnswers).toHaveLength(0);
    expect(
      next.messages
        .filter((message) => message.kind === 'assistant')
        .map((message) => (message.kind === 'assistant' ? message.runId : null)),
    ).toEqual(['r1', 'r2']);
  });

  it('moves a leader run into the transcript when the roster arrives late', () => {
    const key = 'host::late';
    const base = emptyChat(key, 'host');
    const streaming = reduceRoomFrames(base, [
      frame('r1', 'a1', 1, { type: 'status', label: 'starting' }),
      frame('r1', 'a1', 2, { type: 'text_delta', delta: '主答' }),
    ]);
    expect(streaming.messages).toHaveLength(0);
    expect(streaming.pendingAnswers).toHaveLength(1);

    useChat.setState({ activeKey: key, byKey: { [key]: streaming } });
    useChat.getState().setLeaderAgentId('a1');

    const chat = useChat.getState().byKey[key]!;
    expect(chat.leaderAgentId).toBe('a1');
    expect(chat.pendingAnswers).toHaveLength(0);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ kind: 'assistant', runId: 'r1' });
  });
});

describe('room stream teardown', () => {
  const roomKey = 'host::teardown';
  beforeEach(() => {
    vi.mocked(connectionApi.streamStart).mockReset();
    useChat.setState({
      activeKey: roomKey,
      streamKeys: { room: roomKey },
      failedIds: [],
      byKey: {
        [roomKey]: {
          ...emptyChat(roomKey, 'host'),
          sessionId: 's-teardown',
          leaderAgentId: 'a1',
          roomStreamId: 'room',
          messages: [
            { kind: 'user', id: 'u1', text: 'hi' },
            {
              kind: 'assistant',
              id: 'a1msg',
              blocks: [{ kind: 'text', text: '主答中' }],
              usage: null,
              error: null,
              done: false,
              runId: 'r1',
              agentId: 'a1',
            },
          ],
          pendingAnswers: [
            {
              runId: 'r2',
              agentId: 'a2',
              message: {
                kind: 'assistant',
                id: 'a2msg',
                blocks: [{ kind: 'text', text: '补充中' }],
                usage: null,
                error: null,
                done: false,
                runId: 'r2',
                agentId: 'a2',
              },
            },
          ],
        },
      },
    });
  });

  it('finalizes the leader card and flushes pending when the room stream dies', () => {
    useChat.getState().applyStreamEvent({
      streamId: 'room',
      kind: 'done',
      outcome: 'giveup',
      httpCode: 401,
      apiCode: 'unauthorized',
      message: 'nope',
    } as never);

    const chat = useChat.getState().byKey[roomKey]!;
    expect(chat.roomStreamId).toBeNull();
    expect(chat.pendingAnswers).toHaveLength(0);
    expect(chat.messages.filter((message) => message.kind === 'assistant').every((message) =>
      message.kind === 'assistant' ? message.done : true,
    )).toBe(true);
  });
});

describe('leader discovery', () => {
  const roomKey = 'host::discover';
  beforeEach(() => {
    vi.mocked(connectionApi.streamStart).mockReset();
    vi.mocked(api.sessionAgents).mockReset();
    useChat.setState({
      activeKey: roomKey,
      streamKeys: {},
      failedIds: [],
      byKey: {
        [roomKey]: {
          ...emptyChat(roomKey, 'host'),
          sessionId: 's-discover',
          pendingAnswers: [
            {
              runId: 'r1',
              agentId: 'a1',
              message: {
                kind: 'assistant',
                id: 'm1',
                blocks: [{ kind: 'text', text: '主答' }],
                usage: null,
                error: null,
                done: false,
                runId: 'r1',
                agentId: 'a1',
              },
            },
          ],
        },
      },
    });
  });

  it('learns the leader before opening the stream and promotes its pending card', async () => {
    vi.mocked(api.sessionAgents).mockResolvedValue({
      ok: true,
      status: 200,
      data: { leaderId: 'a1', agents: [] },
    } as never);
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true } as never);

    await expect(useChat.getState().ensureRoomStream()).resolves.toBe(true);

    const chat = useChat.getState().byKey[roomKey]!;
    expect(chat.leaderAgentId).toBe('a1');
    expect(chat.pendingAnswers).toHaveLength(0);
    expect(chat.messages.filter((message) => message.kind === 'assistant')).toHaveLength(1);
  });
});
