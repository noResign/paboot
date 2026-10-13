import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../ipc/client', () => ({ api: { session: vi.fn() }, connectionApi: {} }));
vi.mock('./sessions', () => ({ useSessions: { getState: () => ({ refreshCurrent: vi.fn() }) } }));
vi.mock('../notify/notifier', () => ({ notifyRunFinished: vi.fn(), notifyPermission: vi.fn(), closePermissionNotification: vi.fn() }));
import { api } from '../ipc/client';
import { useChat } from './chat';
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
