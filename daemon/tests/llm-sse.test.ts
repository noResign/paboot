import { describe, expect, it } from 'vitest';

import { SseFrameParser } from '../src/llm/sse';

describe('SseFrameParser', () => {
  it('parses fragmented CRLF frames, multi-line data, comments, ids and retry', () => {
    const parser = new SseFrameParser();
    const first = parser.push('event: message_start\r\ndata: {"a":1}\r\n\r\n');
    expect(first).toEqual([{ event: 'message_start', data: '{"a":1}' }]);

    const second = parser.push('data: line1\ndata: line2\nid: 7\nretry: 500\n\n:comment\n');
    expect(second).toEqual([{ event: 'message', data: 'line1\nline2', id: '7', retry: 500 }]);

    parser.push('data: tail');
    expect(parser.end()).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('does not emit empty comment-only frames', () => {
    const parser = new SseFrameParser();
    expect(parser.push(': keepalive\n\n')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });
});
