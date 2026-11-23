import type { QuestionAnswers } from '../types/api.js';

/**
 * Reading a question's answer back out of a permission decision.
 *
 * The response arrives in whatever shape the client used, and every shape has
 * to survive a replay: a card that says "answered" but not *what* was answered
 * makes the user re-read the whole transcript to find out what they chose.
 * So this module exists to turn any accepted shape into one flat map that is
 * persisted on the `question` event.
 */

/** Legacy/free-text answer: a bare string or `{ answer: string }`. */
export function readAnswerText(response: unknown): string | null {
  if (typeof response === 'string' && response.trim().length > 0) return response.trim();
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const answer = (response as Record<string, unknown>)['answer'];
    if (typeof answer === 'string' && answer.trim().length > 0) return answer.trim();
  }
  return null;
}

/**
 * `{ answers: { <questionId>: { answers: string[] } } }` (Codex's shape; builtin
 * accepts it too) flattened to `{ <questionId>: string[] }`.
 *
 * Returns null when the response carries no structured answers at all, which is
 * the normal case for a tool-approval decision — those are not questions.
 */
export function parseStructuredAnswers(response: unknown): QuestionAnswers | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const answers = (response as Record<string, unknown>)['answers'];
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const parsed: QuestionAnswers = {};
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const list = (value as Record<string, unknown>)['answers'];
    if (!Array.isArray(list)) continue;
    const labels = list
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    if (labels.length > 0) parsed[id] = labels;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/**
 * What to persist alongside `answerStatus` for a settled question event.
 *
 * Both channels are kept because they are different answers: a structured map
 * says "question q1 → option B", while free text says "the user typed this".
 * A client renders whichever is present, and neither is invented when absent.
 */
export function answerForEvent(response: unknown): {
  answers: QuestionAnswers | null;
  answerText: string | null;
} {
  return {
    answers: parseStructuredAnswers(response),
    answerText: readAnswerText(response),
  };
}
