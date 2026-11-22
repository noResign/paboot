import { describe, expect, it } from 'vitest';
import { splitSummonLines } from './summonLines';

describe('splitSummonLines', () => {
  it('splits only line-start summon lines into separate messages', () => {
    const result = splitSummonLines(
      [
        '结论：方向没问题。',
        '',
        '@审阅 请复核并发路径',
        '- **@测试** 补一组用例',
        '这段正文提到 @审阅 但不应该被拆出去。',
      ].join('\n'),
      ['审阅', '测试'],
    );
    expect(result.body).toContain('结论：方向没问题。');
    expect(result.body).toContain('这段正文提到 @审阅');
    expect(result.summons).toEqual(['@审阅 请复核并发路径', '- **@测试** 补一组用例']);
  });

  it('leaves code blocks and blockquotes in the body', () => {
    const text = ['```', '@审阅 这只是代码', '```', '> @测试 只是引用'].join('\n');
    expect(splitSummonLines(text, ['审阅', '测试'])).toEqual({ body: text, summons: [] });
  });
});
