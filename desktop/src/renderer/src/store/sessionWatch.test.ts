import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({
  api: { session: vi.fn(), runEvents: vi.fn() },
  connectionApi: { streamStart: vi.fn(), streamCancel: vi.fn() },
}));
vi.mock('./sessions', () => ({
  useSessions: { getState: () => ({ refreshCurrent: vi.fn(), patchTitle: vi.fn() }) },
}));
vi.mock('../notify/notifier', () => ({
  notifyRunFinished: vi.fn(),
  notifyPermission: vi.fn(),
  closePermissionNotification: vi.fn(),
}));
import { connectionApi } from '../ipc/client';
import { useChat } from './chat';
import { emptyChat } from './chat/types';

const key = 'host::s';

function seed(overrides: Partial<ReturnType<typeof emptyChat>> = {}) {
  useChat.setState({
    activeKey: key,
    streamKeys: { watch: key },
    failedIds: [],
    byKey: {
      [key]: {
        ...emptyChat(key, 'host'),
        sessionId: 's',
        sessionStreamId: 'watch',
        ...overrides,
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectionApi.streamStart).mockResolvedValue({ ok: true, streamId: 'run-stream' });
  seed();
});

describe('session watch', () => {
  it('updates the title in place', () => {
    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: { type: 'session_updated', sessionId: 's', title: 'generated title' },
    });
    expect(useChat.getState().byKey[key]!.title).toBe('generated title');
  });

  it('appends a run started on another device and attaches to it', async () => {
    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: {
        type: 'run_started',
        sessionId: 's',
        run: { id: 'r2', prompt: 'from the phone', attachmentIds: [], startedAt: 10, status: 'running' },
      },
    });

    const chat = useChat.getState().byKey[key]!;
    expect(chat.messages[0]).toMatchObject({ kind: 'user', text: 'from the phone', runId: 'r2' });
    expect(chat.messages[1]).toMatchObject({ kind: 'assistant', done: false });
    await vi.waitFor(() =>
      expect(connectionApi.streamStart).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'attach', runId: 'r2' }),
      ),
    );
  });

  it('does nothing while this client is already streaming a run', () => {
    seed({ streamId: 'own' });
    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'session',
      event: {
        type: 'run_started',
        sessionId: 's',
        run: { id: 'r2', prompt: 'x', attachmentIds: [], startedAt: 10, status: 'running' },
      },
    });
    expect(useChat.getState().byKey[key]!.messages).toHaveLength(0);
  });

  it('drops the watch when the daemon ends it', () => {
    useChat.getState().applyStreamEvent({
      streamId: 'watch',
      kind: 'done',
      outcome: 'settled',
      httpCode: 404,
      apiCode: 'session_not_found',
      message: '会话已删除',
    });
    expect(useChat.getState().byKey[key]!.sessionStreamId).toBeNull();
    expect(useChat.getState().streamKeys.watch).toBeUndefined();
  });
});
