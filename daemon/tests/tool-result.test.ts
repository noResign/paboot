import { describe, expect, it } from 'vitest';
import { formatToolResult } from '../src/runtimes/tool-result';

describe('formatToolResult', () => {
  it('keeps text and unwraps ACP content blocks', () => {
    expect(
      formatToolResult([
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'text', text: 'done' },
      ]),
    ).toBe('ok\ndone');
  });

  it('replaces image blocks with a short marker', () => {
    expect(
      formatToolResult({
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
          },
        ],
      }),
    ).toBe('[image omitted: image/jpeg]');
  });

  it('drops long base64 fields even in unknown JSON shapes', () => {
    const rendered = formatToolResult({ wrapper: { data: 'A'.repeat(5_000) } });
    expect(rendered).toContain('[image data omitted]');
    expect(rendered).not.toContain('AAAAA');
  });
});
