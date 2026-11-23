import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({
  api: {
    session: vi.fn(),
    createSession: vi.fn(),
    updateSessionModel: vi.fn(),
    sendTurn: vi.fn(),
    sessionAgents: vi.fn(),
    cancelSessionRuns: vi.fn(),
    cancelTask: vi.fn(),
    decidePermission: vi.fn(),
  },
  connectionApi: { streamStart: vi.fn() },
}));
vi.mock('./sessions', () => ({ useSessions: { getState: () => ({ refreshCurrent: vi.fn() }) } }));
vi.mock('../notify/notifier', () => ({
  notifyRunFinished: vi.fn(),
  notifyPermission: vi.fn(),
  closePermissionNotification: vi.fn(),
  notifyQuestion: vi.fn(),
  closeQuestionNotification: vi.fn(),
}));
import { api, connectionApi } from '../ipc/client';
import { reduceRoomFrames, useChat } from './chat';
import { emptyChat } from './chat/types';
import type { ChatMessage } from './chat/types';
import type { RunDto } from '../../../shared/contract';

const run = { id: 'r', status: 'succeeded' } as RunDto;
const key = 'host::s';
beforeEach(() => {
  vi.clearAllMocks();
  useChat.setState({
    activeKey: key, streamKeys: { stream: key }, failedIds: [],
    byKey: { [key]: { ...emptyChat(key, 'host'), sessionId: 's', streamId: 'stream', runId: 'r', phase: 'live',
      messages: [{ kind: 'user', id: 'u', text: 'hello', runId: 'r' }] } },
  });
});

describe('single-task cancel', () => {
  it('drops the queued row once the daemon accepts', async () => {
    const chat = useChat.getState().byKey[key]!;
    useChat.setState({
      byKey: {
        ...useChat.getState().byKey,
        [key]: { ...chat, dispatchedTasks: [{ taskId: 'task-1', agentId: 'a1' }] },
      },
    });
    vi.mocked(api.cancelTask).mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, taskId: 'task-1', status: 'cancelled' },
    } as never);

    await expect(useChat.getState().cancelTask('task-1')).resolves.toBe(true);
    expect(api.cancelTask).toHaveBeenCalledWith('task-1');
    expect(useChat.getState().byKey[key]!.dispatchedTasks).toHaveLength(0);
  });

  it('keeps the row and reports the error when the daemon refuses', async () => {
    const chat = useChat.getState().byKey[key]!;
    useChat.setState({
      byKey: {
        ...useChat.getState().byKey,
        [key]: { ...chat, dispatchedTasks: [{ taskId: 'task-1', agentId: 'a1' }] },
      },
    });
    vi.mocked(api.cancelTask).mockResolvedValue({
      ok: false,
      status: 404,
      data: { code: 'task_not_found', error: 'task is no longer running' },
    } as never);

    await expect(useChat.getState().cancelTask('task-1')).resolves.toBe(false);
    expect(useChat.getState().byKey[key]!.dispatchedTasks).toHaveLength(1);
    expect(useChat.getState().byKey[key]!.error).toBeTruthy();
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

  it('creates the session, then sends the first message as a normal turn', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        session: {
          id: 's-new',
          runtime: 'builtin',
          workspaceId: 'w',
          permissionMode: 'ask',
          model: 'p:m',
          modelParameters: { reasoningEffort: 'high' },
          cwd: '/w',
          title: 'hi',
          createdAt: 1,
          lastActiveAt: 1,
          running: false,
          runningRunId: null,
        },
      },
    } as never);
    vi.mocked(api.sessionAgents).mockResolvedValue({
      ok: true,
      status: 200,
      data: { leaderId: 'a1', agents: [] },
    } as never);
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true, streamId: 's1' } as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't1', tasks: [] },
    } as never);

    await useChat.getState().setSessionSelection('p:m', { reasoningEffort: 'high' });
    await useChat.getState().send('hi');

    expect(api.createSession).toHaveBeenCalledWith({
      workspaceId: 'w',
      runtime: 'builtin',
      permissionMode: 'ask',
      model: 'p:m',
      modelParameters: { reasoningEffort: 'high' },
      title: 'hi',
    });
    expect(vi.mocked(connectionApi.streamStart).mock.calls[0]![0]).toMatchObject({
      kind: 'room',
      sessionId: 's-new',
    });
    // The chat existed before the session did, so it also has to open the
    // session watch itself — the first-turn title update arrives there.
    expect(vi.mocked(connectionApi.streamStart).mock.calls[1]![0]).toMatchObject({
      kind: 'session',
      sessionId: 's-new',
    });
    expect(api.sendTurn).toHaveBeenCalledWith(
      's-new',
      'hi',
      [],
      expect.any(String),
      [],
    );
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

  it('carries the mode into session creation and the subsequent room turn', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        session: {
          id: 's-new',
          runtime: 'builtin',
          workspaceId: 'w',
          permissionMode: 'bypass',
          model: null,
          modelParameters: null,
          cwd: '/w',
          title: 'hi',
          createdAt: 1,
          lastActiveAt: 1,
          running: false,
          runningRunId: null,
        },
      },
    } as never);
    vi.mocked(api.sessionAgents).mockResolvedValue({
      ok: true,
      status: 200,
      data: { leaderId: 'a1', agents: [] },
    } as never);
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true, streamId: 's1' } as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't1', tasks: [] },
    } as never);

    useChat.getState().setPermissionMode('bypass');
    await useChat.getState().send('hi');

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'bypass' }),
    );
    expect(vi.mocked(connectionApi.streamStart).mock.calls[0]![0]).toMatchObject({
      kind: 'room',
      sessionId: 's-new',
    });
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
  it('refreshes run metadata without reopening or replacing the transcript', async () => {
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

describe('question answers', () => {
  it('finds questions in live/queued answers and marks every copy answered', async () => {
    vi.mocked(api.decidePermission).mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true },
    } as never);
    const question = {
      kind: 'question' as const,
      toolUseId: 'q1',
      questions: [],
      answered: false,
      permissionId: 'p1',
    };
    const message = (id: string) => ({
      kind: 'assistant' as const,
      id,
      runId: 'run-q',
      agentId: 'a1',
      done: false,
      error: null,
      usage: null,
      blocks: [question],
    });
    const key = 'host::question';
    useChat.setState({
      activeKey: key,
      streamKeys: {},
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-question',
          pendingAnswers: [{ runId: 'run-q', agentId: 'a1', message: message('live') }],
          displayQueue: [{ runId: 'run-q-2', agentId: 'a1', message: message('queued') }],
        },
      },
    });

    useChat.getState().answerQuestion('q1', '答案', { q: ['A'] });

    const chat = useChat.getState().byKey[key]!;
    expect(chat.pendingAnswers[0]!.message.blocks[0]).toMatchObject({ answered: true });
    expect(chat.displayQueue[0]!.message.blocks[0]).toMatchObject({ answered: true });
    // The picks are stored on the block, not only sent to the daemon: a live
    // block comes from an event with no answer, so without this the card shows
    // a blank option list until the session is reloaded from events.
    expect(chat.pendingAnswers[0]!.message.blocks[0]).toMatchObject({ answers: { q: ['A'] } });
    await vi.waitFor(() =>
      expect(api.decidePermission).toHaveBeenCalledWith(
        'p1',
        'allow',
        undefined,
        { answers: { q: { answers: ['A'] } } },
      ),
    );
  });

  it('routes a non-leader non-blocking answer back to the agent that asked', async () => {
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't2', tasks: [] },
    } as never);
    const key = 'host::nonblocking';
    useChat.setState({
      activeKey: key,
      streamKeys: {},
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-nonblocking',
          leaderAgentId: 'leader',
          roomStreamId: 'room',
          messages: [
            { kind: 'user', id: 'u', text: '请回答', turnId: 't1' },
            {
              kind: 'assistant',
              id: 'a',
              runId: 'r',
              agentId: 'member',
              done: true,
              error: null,
              usage: null,
              blocks: [{ kind: 'question', toolUseId: 'q-nb', questions: [], answered: false }],
            },
          ],
        },
      },
    });

    useChat.getState().answerQuestion('q-nb', '答案', {});

    await vi.waitFor(() => expect(api.sendTurn).toHaveBeenCalled());
    const call = vi.mocked(api.sendTurn).mock.calls[0]!;
    expect(call[0]).toBe('s-nonblocking');
    expect(call[1]).toBe('答案');
    expect(call[2]).toEqual(['member']);
  });

  it('routes to the asker even before the roster names a leader', async () => {
    vi.mocked(api.sessionAgents).mockResolvedValue(undefined as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't3', tasks: [] },
    } as never);
    const key = 'host::nonblocking-no-leader';
    useChat.setState({
      activeKey: key,
      streamKeys: {},
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-no-leader',
          roomStreamId: 'room',
          messages: [
            { kind: 'user', id: 'u', text: '请回答', turnId: 't1' },
            {
              kind: 'assistant',
              id: 'a',
              runId: 'r',
              agentId: 'member',
              done: true,
              error: null,
              usage: null,
              blocks: [{ kind: 'question', toolUseId: 'q-nb-2', questions: [], answered: false }],
            },
          ],
        },
      },
    });

    useChat.getState().answerQuestion('q-nb-2', '答案', {});

    await vi.waitFor(() => expect(api.sendTurn).toHaveBeenCalled());
    expect(vi.mocked(api.sendTurn).mock.calls[0]![2]).toEqual(['member']);
  });

  it('does not send a non-blocking question that was already answered', () => {
    const key = 'host::answered-question';
    useChat.setState({
      activeKey: key,
      streamKeys: {},
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-answered',
          leaderAgentId: 'leader',
          roomStreamId: 'room',
          messages: [
            {
              kind: 'assistant',
              id: 'a',
              runId: 'r',
              agentId: 'leader',
              done: true,
              error: null,
              usage: null,
              blocks: [{ kind: 'question', toolUseId: 'q-done', questions: [], answered: true }],
            },
          ],
        },
      },
    });

    useChat.getState().answerQuestion('q-done', '答案', {});
    expect(api.sendTurn).not.toHaveBeenCalled();
  });

  it('does not call the permission endpoint for a blocking question whose run ended', () => {
    const key = 'host::closed-question';
    useChat.setState({
      activeKey: key,
      streamKeys: {},
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-closed',
          messages: [
            {
              kind: 'assistant',
              id: 'a',
              runId: 'r',
              agentId: 'a1',
              done: true,
              error: null,
              usage: null,
              blocks: [
                {
                  kind: 'question',
                  toolUseId: 'q-closed',
                  questions: [],
                  answered: false,
                  permissionId: 'p-closed',
                },
              ],
            },
          ],
        },
      },
    });

    useChat.getState().answerQuestion('q-closed', '答案', {});
    expect(api.decidePermission).not.toHaveBeenCalled();
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
    // Both are complete, but presentation is serialized: they wait in the
    // display queue until the scheduler reveals them one by one.
    expect(next.displayQueue.map((answer) => answer.runId)).toEqual(['r2', 'r1']);
    expect(next.messages.filter((message) => message.kind === 'assistant')).toHaveLength(0);
  });

  it('never repaints the session runtime from a member agent frame', () => {
    const base = { ...emptyChat('host::room', 'host'), runtime: 'claude' };
    const next = reduceRoomFrames(base, [
      frame('r1', 'builtin-member', 1, { type: 'status', label: 'starting', runtime: 'builtin' }),
    ]);

    // The header names the leader; a supplementary agent's backend is local to
    // its own answer.
    expect(next.runtime).toBe('claude');
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
    // The optimistic bubble stays visible even though the handshake failed.
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ kind: 'user', text: 'hi' });
    expect(chat.turnSending).toBe(false);
  });

  it('shows the user bubble before the room stream handshake completes', async () => {
    vi.mocked(api.sessionAgents).mockResolvedValue({
      ok: true,
      status: 200,
      data: { leaderId: 'a1', agents: [] },
    } as never);
    let release!: (value: unknown) => void;
    vi.mocked(connectionApi.streamStart).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );

    const sending = useChat.getState().sendTurn('hi', []);
    await vi.waitFor(() => {
      expect(useChat.getState().byKey[roomKey]!.messages).toHaveLength(1);
    });
    expect(useChat.getState().byKey[roomKey]!.turnSending).toBe(true);

    release({ ok: false, httpCode: 500, apiCode: null, message: 'boom' });
    await sending;
    expect(useChat.getState().byKey[roomKey]!.turnSending).toBe(false);
  });

  it('shows acknowledged tasks until their first run frame arrives', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: {
        turnId: 't1',
        tasks: [{ id: 'task-1', agentId: 'a1' }],
      },
    } as never);

    await useChat.getState().sendTurn('hi', []);
    expect(useChat.getState().byKey[roomKey]!.dispatchedTasks).toEqual([
      { taskId: 'task-1', agentId: 'a1' },
    ]);

    useChat.getState().applyStreamEvent({
      streamId: useChat.getState().byKey[roomKey]!.roomStreamId,
      kind: 'frames',
      frames: [{ runId: 'r1', seq: 1, taskId: 'task-1', agentId: 'a1', event: { type: 'status', label: 'starting' } }],
    } as never);
    expect(useChat.getState().byKey[roomKey]!.dispatchedTasks).toHaveLength(0);
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

  it('sends attachments with an @ mention and keeps them on the question', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't1', tasks: [] },
    } as never);

    await useChat.getState().sendTurn('看这张图', ['a1'], ['img-1']);

    expect(api.sendTurn).toHaveBeenCalledWith(
      's-turn',
      '看这张图',
      ['a1'],
      expect.any(String),
      ['img-1'],
    );
    expect(useChat.getState().byKey[roomKey]!.messages[0]).toMatchObject({
      kind: 'user',
      text: '看这张图',
      attachmentIds: ['img-1'],
    });
  });

  it('lets an image-only room send reuse the single-chat fallback prompt', async () => {
    vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.sendTurn).mockResolvedValue({
      ok: true,
      status: 202,
      data: { turnId: 't1', tasks: [] },
    } as never);

    await useChat.getState().sendTurn('', [], ['img-1']);

    expect(api.sendTurn).toHaveBeenCalledWith(
      's-turn',
      '请查看这些图片。',
      [],
      expect.any(String),
      ['img-1'],
    );
  });
});

describe('stopping a room', () => {
  it('cancels every run on the daemon and finalizes what is on screen', async () => {
    const roomKey = 'host::stop-room';
    vi.mocked(api.cancelSessionRuns).mockResolvedValue({ ok: true, cancelled: 2 } as never);
    useChat.setState({
      activeKey: roomKey,
      streamKeys: { room: roomKey },
      failedIds: [],
      byKey: {
        [roomKey]: {
          ...emptyChat(roomKey, 'host'),
          sessionId: 's-stop',
          roomStreamId: 'room',
          leaderAgentId: 'a1',
          messages: [
            { kind: 'user', id: 'u1', text: 'hi' },
            {
              kind: 'assistant',
              id: 'a1msg',
              runId: 'r1',
              agentId: 'a1',
              done: false,
              error: null,
              usage: null,
              blocks: [{ kind: 'text', text: '主答中' }],
            },
          ],
          pendingAnswers: [
            {
              runId: 'r2',
              agentId: 'a2',
              message: {
                kind: 'assistant',
                id: 'a2msg',
                runId: 'r2',
                agentId: 'a2',
                done: false,
                error: null,
                usage: null,
                blocks: [{ kind: 'text', text: '补充中' }],
              },
            },
          ],
        },
      },
    });

    useChat.getState().stop();
    await vi.waitFor(() => expect(api.cancelSessionRuns).toHaveBeenCalledWith('s-stop'));

    const chat = useChat.getState().byKey[roomKey]!;
    expect(chat.roomStreamId).toBe('room');
    expect(chat.pendingAnswers).toHaveLength(0);
    expect(chat.messages.filter((message) => message.kind === 'assistant').every((message) =>
      message.kind === 'assistant' ? message.done : true,
    )).toBe(true);
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

  it('keeps every streaming agent in the live area until it commits', () => {
    const base = { ...emptyChat('host::leader', 'host'), leaderAgentId: 'a1' };
    const streaming = reduceRoomFrames(base, [
      frame('r1', 'a1', 1, { type: 'status', label: 'starting' }),
      frame('r2', 'a2', 1, { type: 'status', label: 'starting' }),
      frame('r1', 'a1', 2, { type: 'text_delta', delta: '主答' }),
      frame('r2', 'a2', 2, { type: 'text_delta', delta: '补充' }),
    ]);

    expect(streaming.messages.filter((message) => message.kind === 'assistant')).toHaveLength(0);
    expect(streaming.pendingAnswers.map((answer) => answer.runId)).toEqual(['r1', 'r2']);

    const next = reduceRoomFrames(streaming, [
      frame('r1', 'a1', 3, { type: 'status', label: 'succeeded', terminal: true }),
      frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true }),
    ]);
    expect(next.pendingAnswers).toHaveLength(0);
    expect(next.messages.filter((message) => message.kind === 'assistant')).toHaveLength(0);
    expect(next.displayQueue.map((answer) => answer.runId)).toEqual(['r1', 'r2']);
  });

  it('hydrates a partial history card instead of duplicating a non-leader answer', () => {
    const base = {
      ...emptyChat('host::hydrate', 'host'),
      leaderAgentId: 'a1',
      messages: [
        { kind: 'user' as const, id: 'u1', text: '看图' },
        {
          kind: 'assistant' as const,
          id: 'a2msg',
          runId: 'r2',
          agentId: 'a2',
          done: false,
          error: null,
          usage: null,
          blocks: [{ kind: 'text' as const, text: '前缀' }],
        },
      ],
    };
    const streaming = reduceRoomFrames(base, [
      frame('r2', 'a2', 2, { type: 'text_delta', delta: '补充' }),
    ]);
    expect(streaming.messages.filter((message) => message.kind === 'assistant')).toHaveLength(0);
    expect(streaming.pendingAnswers).toHaveLength(1);
    expect(streaming.pendingAnswers[0]!.message.blocks).toEqual([
      { kind: 'text', text: '前缀补充' },
    ]);

    const done = reduceRoomFrames(streaming, [
      frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true }),
    ]);
    expect(done.messages.filter((message) => message.kind === 'assistant')).toHaveLength(0);
    expect(done.displayQueue).toHaveLength(1);
    expect(done.displayQueue[0]!.message).toMatchObject({ runId: 'r2', done: true });
  });

  it('reveals completed answers one at a time after the live speaker stops', () => {
    vi.useFakeTimers();
    try {
      const key = 'host::display-queue';
      const base = {
        ...emptyChat(key, 'host'),
        sessionId: 's-display',
        roomStreamId: 'room-display',
        leaderAgentId: 'a1',
        displayQueue: [
          {
            runId: 'r2',
            agentId: 'a2',
            message: {
              kind: 'assistant' as const,
              id: 'a2m',
              blocks: [{ kind: 'text' as const, text: 'B' }],
              usage: null,
              error: null,
              done: true,
              runId: 'r2',
              agentId: 'a2',
            },
          },
          {
            runId: 'r3',
            agentId: 'a3',
            message: {
              kind: 'assistant' as const,
              id: 'a3m',
              blocks: [{ kind: 'text' as const, text: 'C' }],
              usage: null,
              error: null,
              done: true,
              runId: 'r3',
              agentId: 'a3',
            },
          },
        ],
      };
      useChat.setState({
        activeKey: key,
        streamKeys: { 'room-display': key },
        failedIds: [],
        byKey: { [key]: base },
      });

      useChat.getState().applyStreamEvent({
        streamId: 'room-display',
        kind: 'frames',
        frames: [],
      } as never);
      let chat = useChat.getState().byKey[key]!;
      expect(
        chat.messages
          .filter((message) => message.kind === 'assistant')
          .map((message) => (message.kind === 'assistant' ? message.runId : null)),
      ).toEqual(['r2']);
      expect(chat.displayQueue.map((answer) => answer.runId)).toEqual(['r3']);

      vi.advanceTimersByTime(300);
      chat = useChat.getState().byKey[key]!;
      expect(
        chat.messages
          .filter((message) => message.kind === 'assistant')
          .map((message) => (message.kind === 'assistant' ? message.runId : null)),
      ).toEqual(['r2', 'r3']);
      expect(chat.displayQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a completed non-leader until the live leader finishes, then shows it', () => {
    const key = 'host::wait-leader';
    const leaderMessage = {
      kind: 'assistant' as const,
      id: 'leader-msg',
      runId: 'r1',
      agentId: 'a1',
      done: false,
      error: null,
      usage: null,
      blocks: [{ kind: 'text' as const, text: '主答中' }],
    };
    const pendingMessage = {
      kind: 'assistant' as const,
      id: 'member-msg',
      runId: 'r2',
      agentId: 'a2',
      done: false,
      error: null,
      usage: null,
      blocks: [{ kind: 'text' as const, text: '补充完成' }],
    };
    useChat.setState({
      activeKey: key,
      streamKeys: { room: key },
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-wait',
          roomStreamId: 'room',
          leaderAgentId: 'a1',
          messages: [{ kind: 'user', id: 'u1', text: '开始' }, leaderMessage],
          pendingAnswers: [{ runId: 'r2', agentId: 'a2', message: pendingMessage }],
        },
      },
    });

    useChat.getState().applyStreamEvent({
      streamId: 'room',
      kind: 'frames',
      frames: [
        frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true }),
      ],
    } as never);
    let chat = useChat.getState().byKey[key]!;
    expect(chat.displayQueue.map((answer) => answer.runId)).toEqual(['r2']);
    expect(chat.messages.some((message) => message.kind === 'assistant' && message.runId === 'r2')).toBe(false);

    useChat.getState().applyStreamEvent({
      streamId: 'room',
      kind: 'frames',
      frames: [
        frame('r1', 'a1', 4, { type: 'status', label: 'succeeded', terminal: true }),
      ],
    } as never);
    chat = useChat.getState().byKey[key]!;
    expect(
      chat.messages
        .filter((message) => message.kind === 'assistant')
        .map((message) => (message.kind === 'assistant' ? message.runId : null)),
    ).toEqual(['r2']);
    expect(chat.displayQueue.map((answer) => answer.runId)).toEqual(['r1']);
  });

  it('does not let a live assistant-tab answer hold a completed answer back', () => {
    const key = 'host::decoupled';
    const liveMessage = {
      kind: 'assistant' as const,
      id: 'live-msg',
      runId: 'r1',
      agentId: 'a1',
      done: false,
      error: null,
      usage: null,
      blocks: [{ kind: 'text' as const, text: '还在说' }],
    };
    useChat.setState({
      activeKey: key,
      streamKeys: { room: key },
      failedIds: [],
      byKey: {
        [key]: {
          ...emptyChat(key, 'host'),
          sessionId: 's-decoupled',
          roomStreamId: 'room',
          leaderAgentId: 'a1',
          messages: [{ kind: 'user', id: 'u1', text: '开始' }],
          // A room answer is live, but only in the assistant tab — the
          // transcript is not writing anything.
          pendingAnswers: [{ runId: 'r1', agentId: 'a1', message: liveMessage }],
        },
      },
    });

    useChat.getState().applyStreamEvent({
      streamId: 'room',
      kind: 'frames',
      frames: [frame('r2', 'a2', 3, { type: 'status', label: 'succeeded', terminal: true })],
    } as never);

    const chat = useChat.getState().byKey[key]!;
    expect(
      chat.messages
        .filter((message) => message.kind === 'assistant')
        .map((message) => (message.kind === 'assistant' ? message.runId : null)),
    ).toEqual(['r2']);
    expect(chat.pendingAnswers.map((answer) => answer.runId)).toEqual(['r1']);
  });

  it('does not move a live answer into the transcript when the roster arrives', () => {
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
    expect(chat.pendingAnswers).toHaveLength(1);
    expect(chat.messages).toHaveLength(0);
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
    expect(chat.pendingAnswers).toHaveLength(1);
    expect(chat.messages.filter((message) => message.kind === 'assistant')).toHaveLength(0);
  });
});
