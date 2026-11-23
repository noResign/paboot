import { describe, expect, it } from 'vitest';
import { answerForEvent, parseStructuredAnswers, readAnswerText } from '../src/permissions/question-answers';

/**
 * What a settled question remembers.
 *
 * The card is rebuilt from events on every re-entry, so anything not persisted
 * here is gone: the user used to see "已发送答案" over a blank option list and
 * had to re-read the transcript to find out what they had chosen.
 */

describe('parseStructuredAnswers', () => {
  it('flattens the Codex/builtin nested shape', () => {
    // This is exactly what a client posts to POST /api/permissions/:id/decision.
    expect(parseStructuredAnswers({ answers: { q1: { answers: ['方案 A'] } } })).toEqual({
      q1: ['方案 A'],
    });
  });

  it('keeps every label of a multi-select question', () => {
    expect(
      parseStructuredAnswers({ answers: { q1: { answers: ['A', 'B', 'C'] } } }),
    ).toEqual({ q1: ['A', 'B', 'C'] });
  });

  it('drops empty and non-string labels instead of persisting junk', () => {
    expect(
      parseStructuredAnswers({ answers: { q1: { answers: ['A', '', '  ', 42] } } }),
    ).toEqual({ q1: ['A'] });
  });

  it('returns null when there is nothing structured to record', () => {
    // A tool approval carries no `answers`; recording an empty map would make
    // the card claim something was chosen.
    expect(parseStructuredAnswers(undefined)).toBeNull();
    expect(parseStructuredAnswers(null)).toBeNull();
    expect(parseStructuredAnswers({})).toBeNull();
    expect(parseStructuredAnswers({ answers: {} })).toBeNull();
    expect(parseStructuredAnswers({ answers: { q1: { answers: [] } } })).toBeNull();
    expect(parseStructuredAnswers('free text')).toBeNull();
  });
});

describe('readAnswerText', () => {
  it('accepts both legacy free-text shapes', () => {
    expect(readAnswerText('自己写的')).toBe('自己写的');
    expect(readAnswerText({ answer: '自己写的' })).toBe('自己写的');
  });

  it('ignores an empty or missing string', () => {
    expect(readAnswerText('   ')).toBeNull();
    expect(readAnswerText({})).toBeNull();
    expect(readAnswerText({ answers: { q1: { answers: ['A'] } } })).toBeNull();
  });
});

describe('answerForEvent', () => {
  it('keeps picks and free text apart', () => {
    expect(
      answerForEvent({ answers: { q1: { answers: ['方案 A', '其他：我自己的想法'] } } }),
    ).toEqual({ answers: { q1: ['方案 A', '其他：我自己的想法'] }, answerText: null });
  });

  it('reports a pure free-text answer through answerText only', () => {
    expect(answerForEvent({ answer: '随便' })).toEqual({ answers: null, answerText: '随便' });
  });

  it('records nothing for a plain approval', () => {
    expect(answerForEvent(undefined)).toEqual({ answers: null, answerText: null });
  });
});
