import { describe, expect, it } from 'vitest';
import {
  bestCompletionMatch,
  completionScore,
  createCompletionMatcher,
  isCompletionMatch,
  looksCompleted,
  matchTokens,
} from '../src/memory/loop-match';

describe('loop completion matching (D38)', () => {
  it('tokenises CJK as bigrams and keeps latin identifiers whole', () => {
    const tokens = matchTokens('补测试 recorder.test.ts');
    expect(tokens.has('测试')).toBe(true);
    expect(tokens.has('recorder.test.ts')).toBe(true);
  });

  it('matches a loop whose topic is covered by the completion text', () => {
    expect(looksCompleted('补完 memory 的单元测试并通过全量套件', '补 memory 单元测试')).toBe(true);
  });

  it('ignores completions that mention unrelated work', () => {
    expect(looksCompleted('把桌面端图标换成新配色', '补 memory 单元测试')).toBe(false);
  });

  it('ignores an empty completion', () => {
    expect(looksCompleted('', '补 memory 单元测试')).toBe(false);
    expect(looksCompleted('   ', '补 memory 单元测试')).toBe(false);
  });

  it('requires more than one shared bigram to avoid generic-word matches', () => {
    // Only "计划" overlaps: one shared token is not evidence.
    expect(looksCompleted('计划做别的', '计划')).toBe(false);
  });

  it('is monotonic: a fuller match scores higher', () => {
    const partial = completionScore('改完 proxy 代理', '改 proxy 代理并补测试');
    const full = completionScore('改完 proxy 代理并补测试', '改 proxy 代理并补测试');
    expect(full).toBeGreaterThan(partial);
    expect(full).toBe(1);
  });

  // Both rules below came from running the matcher over a real 170-loop corpus;
  // they are the difference between a usable review list and pure noise.

  it('scores per sentence, so unrelated topics in one summary do not add up', () => {
    // Whole-text containment would count 提交 + 改动 = 2/3 and match; neither
    // sentence alone is about the loop, so per-sentence scoring must not.
    const summary = '改动已合并到 main。稍后提交另一件事。';
    expect(looksCompleted(summary, '提交改动')).toBe(false);
    expect(completionScore('改动已合并到 main。稍后提交另一件事。', '提交改动')).toBeLessThan(0.5);
  });

  it('rejects sentences that say the work is still pending', () => {
    // Summaries restate open loops verbatim as remaining work — the strongest
    // false positive there is.
    expect(looksCompleted('还剩最后一项：提交改动', '提交改动')).toBe(false);
    expect(looksCompleted('改动尚未提交', '提交改动')).toBe(false);
    expect(looksCompleted('将改动拆成 3 个 commit 并提交', '提交改动')).toBe(true);
  });

  it('reports the sentence that matched, for audit', () => {
    const match = bestCompletionMatch('先做了别的。将改动拆成 3 个 commit 并提交。', '提交改动');
    expect(match.sentence).toBe('将改动拆成 3 个 commit 并提交');
    expect(match.score).toBeGreaterThanOrEqual(0.5);
  });
});
