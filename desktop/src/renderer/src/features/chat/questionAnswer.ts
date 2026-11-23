import type { QuestionAnswers, QuestionDto } from '../../../../shared/contract';

/** question index → the option labels picked for it. */
export type QuestionSelections = Record<number, string[]>;

/**
 * Mirrors the Android client's `QuestionCard`: a `multiSelect` question keeps a
 * list, a single-choice one replaces. Pure so the send-on-complete rule is
 * testable without a DOM.
 */
export function toggleSelection(
  selections: QuestionSelections,
  index: number,
  label: string,
  multiSelect: boolean | undefined,
): QuestionSelections {
  const current = selections[index] ?? [];
  const next = multiSelect
    ? current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label]
    : [label];
  return { ...selections, [index]: next };
}

/** question index → the free-text "其他" answer. */
export type QuestionOthers = Record<number, { active: boolean; text: string }>;

export function isFullyAnswered(
  questions: QuestionDto[],
  selections: QuestionSelections,
  others: QuestionOthers = {},
): boolean {
  return (
    questions.length > 0 &&
    questions.every((_, index) => {
      if ((selections[index] ?? []).length > 0) return true;
      const other = others[index];
      return Boolean(other?.active) && (other?.text.trim().length ?? 0) > 0;
    })
  );
}

/**
 * The answer goes back as an ordinary continuation turn, not a tool result:
 * headless Claude auto-denies `AskUserQuestion`, so there is nothing left to
 * backfill. Wording matches the Android client so both read identically in the
 * transcript.
 */
/** Blocking answer payload: `{ questionId: [labels] }` (Codex/builtin shape). */
export function buildStructuredAnswers(
  questions: QuestionDto[],
  selections: QuestionSelections,
  others: QuestionOthers = {},
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  questions.forEach((question, index) => {
    const labels = [...(selections[index] ?? [])];
    const other = others[index];
    if (other?.active && other.text.trim()) labels.push(`其他：${other.text.trim()}`);
    answers[question.id ?? String(index)] = labels;
  });
  return answers;
}

export function buildAnswerText(
  questions: QuestionDto[],
  selections: QuestionSelections,
  others: QuestionOthers = {},
): string {
  return questions
    .map((question, index) => {
      const parts = [...(selections[index] ?? [])];
      const other = others[index];
      if (other?.active && other.text.trim()) parts.push(`其他：${other.text.trim()}`);
      return `关于「${question.question}」，我的选择是：${parts.join('、')}`;
    })
    .join('\n');
}

/** The marker `buildStructuredAnswers` uses for a typed answer. */
const OTHER_PREFIX = '其他：';

/**
 * Rebuild the card's local state from a replayed answer.
 *
 * A settled card has to look exactly like it did the moment it was sent —
 * otherwise the user re-reads the transcript to find out what they chose
 * (which is what this whole field exists to prevent). Labels that are not
 * options were typed into「其他」, so they come back as text rather than as a
 * phantom selection.
 */
export function selectionsFromAnswers(
  questions: QuestionDto[],
  answers: QuestionAnswers | null | undefined,
): { selections: QuestionSelections; others: QuestionOthers } {
  const selections: QuestionSelections = {};
  const others: QuestionOthers = {};
  if (!answers) return { selections, others };

  questions.forEach((question, index) => {
    const labels = answers[question.id ?? String(index)] ?? [];
    const known = new Set(question.options.map((option) => option.label));
    const picked: string[] = [];
    const typed: string[] = [];
    for (const label of labels) {
      if (known.has(label)) picked.push(label);
      else if (label.startsWith(OTHER_PREFIX)) typed.push(label.slice(OTHER_PREFIX.length));
      else typed.push(label);
    }
    if (picked.length > 0) selections[index] = picked;
    if (typed.length > 0) others[index] = { active: true, text: typed.join('、') };
  });
  return { selections, others };
}
