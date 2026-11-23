import { describe, expect, it } from 'vitest';
import { apiErrorOf, describeDropped, dropReasonLabel, friendlyMessage } from './errors';

describe('friendlyMessage', () => {
  it('maps a known daemon code', () => {
    expect(friendlyMessage('runtime_unavailable', 503, 'nope')).toBe(
      '该 Agent 未安装或不在 PATH 上，请在电脑端确认',
    );
  });

  it('interpolates the server detail for validation failures', () => {
    expect(friendlyMessage('bad_response', 400, 'missing field')).toBe('回答不符合要求：missing field');
  });

  it('falls back to the HTTP status, then to the generic prefix', () => {
    expect(friendlyMessage(null, 401, 'unauthorized')).toContain('401');
    expect(friendlyMessage(null, 0, 'boom')).toContain('无法连接 daemon');
    expect(friendlyMessage(null, 500, 'boom')).toBe('请求失败：boom');
    expect(friendlyMessage(null, 500, 'boom', '加载失败')).toBe('加载失败：boom');
  });

  it('surfaces session_busy as a queue-ish message, not a generic error', () => {
    // The 409 from the M0 same-session guard is a normal race, not a bug.
    expect(friendlyMessage('session_busy', 409, 'busy')).not.toContain('409');
  });
});

describe('dropped mentions', () => {
  it('names every address that got no task, with the reason', () => {
    // A full room is the case this exists for: the turn still succeeds, so
    // without this the mention just looks dead.
    expect(
      describeDropped([
        { name: '审阅', reason: 'disabled' },
        { name: '实现', reason: 'room_full' },
      ]),
    ).toBe('审阅（已停用）、实现（房间已满）没有收到这条消息');
  });

  it('says nothing when every addressed agent got a task', () => {
    expect(describeDropped([])).toBeNull();
  });

  it('falls back to a neutral label for a reason it does not know', () => {
    // Older daemons can add reasons; an unknown one must not render blank.
    expect(dropReasonLabel('some_future_reason')).toBe('未收到任务');
  });
});

describe('apiErrorOf', () => {
  it('prefers message, then error, then a placeholder', () => {
    expect(apiErrorOf({ code: 'x', message: 'm' })).toEqual({ apiCode: 'x', message: 'm' });
    expect(apiErrorOf({ error: 'e' })).toEqual({ apiCode: null, message: 'e' });
    expect(apiErrorOf('oops')).toEqual({ apiCode: null, message: 'oops' });
    expect(apiErrorOf(null)).toEqual({ apiCode: null, message: 'unknown error' });
  });
});
