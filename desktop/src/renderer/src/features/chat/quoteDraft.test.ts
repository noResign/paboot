import { describe, expect, it } from 'vitest';
import { quoteBlock } from './quoteDraft';

describe('quoteBlock', () => {
  it('collapses whitespace and names the author', () => {
    expect(quoteBlock({ author: '审阅', text: 'line 1\n\n  line 2  ' })).toBe(
      '> 引用 审阅：line 1 line 2',
    );
  });

  it('omits the author when it is unknown', () => {
    expect(quoteBlock({ author: null, text: 'hi' })).toBe('> 引用：hi');
  });

  it('caps a long quoted message', () => {
    const out = quoteBlock({ author: 'A', text: 'x'.repeat(400) });
    expect(out.startsWith('> 引用 A：')).toBe(true);
    expect(out.length).toBeLessThan(200);
  });

  it('is a blockquote line, so an @ inside it routes nobody', () => {
    expect(quoteBlock({ author: 'A', text: '@审阅 看一下' }).split('\n')).toHaveLength(1);
    expect(quoteBlock({ author: 'A', text: '@审阅 看一下' }).startsWith('>')).toBe(true);
  });
});
