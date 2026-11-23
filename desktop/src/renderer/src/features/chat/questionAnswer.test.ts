import { describe, expect, it } from 'vitest';
import {
  buildAnswerText,
  buildStructuredAnswers,
  isFullyAnswered,
  selectionsFromAnswers,
  toggleSelection,
} from './questionAnswer';
import type { QuestionDto } from '../../../../shared/contract';

const single: QuestionDto = {
  question: '用哪个 runtime？',
  multiSelect: false,
  options: [{ label: 'Claude' }, { label: 'Codex' }],
};

const multi: QuestionDto = {
  question: '开哪些页？',
  multiSelect: true,
  options: [{ label: '会话' }, { label: '文件' }],
};

describe('toggleSelection', () => {
  it('replaces the pick for a single-choice question', () => {
    const first = toggleSelection({}, 0, 'Claude', false);
    expect(first[0]).toEqual(['Claude']);
    expect(toggleSelection(first, 0, 'Codex', false)[0]).toEqual(['Codex']);
  });

  it('adds and removes labels for a multi-select question', () => {
    const first = toggleSelection({}, 0, '会话', true);
    const both = toggleSelection(first, 0, '文件', true);
    expect(both[0]).toEqual(['会话', '文件']);
    expect(toggleSelection(both, 0, '会话', true)[0]).toEqual(['文件']);
  });

  it('keys by question index so two questions stay independent', () => {
    let selections = toggleSelection({}, 0, 'Claude', false);
    selections = toggleSelection(selections, 1, '文件', true);
    expect(selections).toEqual({ 0: ['Claude'], 1: ['文件'] });
  });
});

describe('isFullyAnswered', () => {
  it('requires a pick for every question', () => {
    expect(isFullyAnswered([single, multi], { 0: ['Claude'] })).toBe(false);
    expect(isFullyAnswered([single, multi], { 0: ['Claude'], 1: ['文件'] })).toBe(true);
  });

  it('is false for an empty question list', () => {
    expect(isFullyAnswered([], {})).toBe(false);
  });

  it('accepts a non-empty "其他" answer when no option fits', () => {
    expect(isFullyAnswered([single], {}, { 0: { active: true, text: '  ' } })).toBe(false);
    expect(isFullyAnswered([single], {}, { 0: { active: true, text: '其他 runtime' } })).toBe(true);
  });
});

describe('buildStructuredAnswers', () => {
  it('keys answers by question id (falling back to the index)', () => {
    const withId: QuestionDto = { ...single, id: 'q1' };
    expect(
      buildStructuredAnswers([withId, multi], { 0: ['Claude'], 1: ['文件'] }),
    ).toEqual({ q1: ['Claude'], 1: ['文件'] });
  });

  it('appends the custom "其他" text to the labels', () => {
    const withId: QuestionDto = { ...multi, id: 'q1' };
    expect(
      buildStructuredAnswers([withId], { 0: ['会话'] }, { 0: { active: true, text: '任务' } }),
    ).toEqual({ q1: ['会话', '其他：任务'] });
  });
});

describe('buildAnswerText', () => {
  it('names the question and joins multi-select picks', () => {
    expect(buildAnswerText([multi], { 0: ['会话', '文件'] })).toBe(
      '关于「开哪些页？」，我的选择是：会话、文件',
    );
  });

  it('puts one line per question', () => {
    expect(buildAnswerText([single, multi], { 0: ['Codex'], 1: ['会话'] })).toBe(
      '关于「用哪个 runtime？」，我的选择是：Codex\n关于「开哪些页？」，我的选择是：会话',
    );
  });

  it('includes the custom "其他" text', () => {
    expect(
      buildAnswerText([multi], { 0: ['会话'] }, { 0: { active: true, text: '任务' } }),
    ).toBe('关于「开哪些页？」，我的选择是：会话、其他：任务');
    expect(
      buildAnswerText([single], {}, { 0: { active: true, text: '别的' } }),
    ).toBe('关于「用哪个 runtime？」，我的选择是：其他：别的');
  });
});

describe('selectionsFromAnswers', () => {
  // Exact payload captured from a real answered question, so this stays a
  // regression test for the round trip rather than a synthetic guess.
  const singleWithPicks: QuestionDto = {
    id: 'q0',
    question: '下一步先做哪一件？',
    multiSelect: false,
    options: [
      { label: '移动端接房间流' },
      { label: '补 P2 剩余细节' },
      { label: '先不稳，继续验证' },
    ],
  };
  const multiWithOther: QuestionDto = {
    id: 'q1',
    question: '请随便勾 2 项以上',
    multiSelect: true,
    options: [
      { label: '选项回填正确' },
      { label: '「其他」原文回填正确' },
      { label: '底部文案显示选择' },
      { label: '轨迹页同样正确' },
    ],
  };

  it('restores a pick and a typed answer from one payload', () => {
    const { selections, others } = selectionsFromAnswers(
      [singleWithPicks, multiWithOther],
      { q0: ['先不稳，继续验证'], q1: ['轨迹页同样正确', '其他：测试'] },
    );
    // A real option comes back as a selection...
    expect(selections[0]).toEqual(['先不稳，继续验证']);
    expect(selections[1]).toEqual(['轨迹页同样正确']);
    // ...while `其他：…` comes back as text, not as a phantom option.
    expect(others[1]).toEqual({ active: true, text: '测试' });
  });

  it('falls back to the question index when an option list has no ids', () => {
    // Older daemons key nothing; the widget still has to line up.
    const { selections } = selectionsFromAnswers(
      [{ ...singleWithPicks, id: undefined }],
      { '0': ['移动端接房间流'] },
    );
    expect(selections[0]).toEqual(['移动端接房间流']);
  });

  it('returns empty state for a question answered by an older daemon', () => {
    const { selections, others } = selectionsFromAnswers([singleWithPicks], undefined);
    expect(selections).toEqual({});
    expect(others).toEqual({});
  });
});
