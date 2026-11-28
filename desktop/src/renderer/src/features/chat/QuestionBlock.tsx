import { useEffect, useState } from 'react';
import { isBusy, useChat } from '../../store/chat';
import {
  buildAnswerText,
  buildStructuredAnswers,
  isFullyAnswered,
  selectionsFromAnswers,
  toggleSelection,
} from './questionAnswer';
import type { QuestionOthers, QuestionSelections } from './questionAnswer';
import type { QuestionAnswers, QuestionDto } from '../../../../shared/contract';

interface Props {
  toolUseId: string;
  questions: QuestionDto[];
  answered: boolean;
  /** How the daemon settled it (replay); any value makes the ask inert. */
  answerStatus?: 'allowed' | 'denied' | 'timed_out' | null;
  /** What was picked, so a settled card shows the choice instead of a blank form. */
  answers?: QuestionAnswers | null;
  /** The typed answer, when the user chose to write one. */
  answerText?: string | null;
  /** Builtin blocking question: answer while the run is still live. */
  permissionId?: string | null;
  /**
   * False when this card belongs to a past turn. `answered` is client-only and
   * resets on every history rebuild, so the only durable signal that a question
   * is still live is that it sits after the latest user message.
   */
  interactive?: boolean;
  /**
   * A blocking question whose run has already ended: the permission id is dead,
   * so the card is a historical record rather than an actionable ask.
   */
  closed?: boolean;
}

/**
 * An `AskUserQuestion` card. Headless Claude auto-denies the tool, so its answer
 * can only be a continuation turn after the run stops. Builtin blocks the run
 * instead (`permissionId`), so its answer is sent immediately and becomes the
 * tool result.
 */
export function QuestionBlock({
  toolUseId,
  questions,
  answered,
  answerStatus = null,
  answers = null,
  answerText = null,
  permissionId,
  interactive = true,
  closed = false,
}: Props) {
  const busy = useChat((state) => {
    const chat = state.activeKey ? state.byKey[state.activeKey] : undefined;
    return chat ? isBusy(chat.phase) : false;
  });
  const answerQuestion = useChat((state) => state.answerQuestion);
  const [selections, setSelections] = useState<QuestionSelections>({});
  const [others, setOthers] = useState<QuestionOthers>({});

  // A recycled slot (the transcript keys segments by index) must not inherit the
  // previous question's picks. A replayed answer repopulates them from the
  // event: the card has to show what was chosen, not an empty form saying
  // "already sent".
  useEffect(() => {
    const restored = selectionsFromAnswers(questions, answers);
    // A free-text answer is not tied to one question, so it goes in the first
    // card's「其他」field — where the user typed it in the first place.
    if (answerText) restored.others[0] = { active: true, text: answerText };
    setSelections(restored.selections);
    setOthers(restored.others);
    // `questions` is read for its options but must not re-run this: it is a
    // fresh array on every event applied, and re-running would wipe picks the
    // user is still making.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolUseId, answers, answerText]);

  const anyOther = Object.values(others).some((entry) => entry.active);
  const complete = isFullyAnswered(questions, selections, others);
  const blocking = Boolean(permissionId);
  const readonly = closed || answerStatus !== null || !interactive;

  // A card that settled with no durable answer (e.g. Claude auto-denied it) must
  // not keep the local clicks from when it was live: the footer already says the
  // answer is not retained, so a stale check mark reads as a bug.
  useEffect(() => {
    if (!readonly || answers || answerText) return;
    setSelections({});
    setOthers({});
  }, [readonly, answers, answerText]);

  useEffect(() => {
    // Builtin blocks the run, so a blocking question must be confirmed with the
    // button: the user may still be toggling options. Headless Claude can only
    // answer after the turn ends, so that path keeps auto-sending — but only
    // while the question still belongs to the current turn.
    if (answered || readonly || !complete || anyOther || blocking) return;
    if (busy) return;
    answerQuestion(
      toolUseId,
      buildAnswerText(questions, selections, others),
      buildStructuredAnswers(questions, selections, others),
    );
    // `selections` is read only through `complete`, which flips exactly when the
    // picks become sendable; depending on it directly would fire on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, busy, blocking, complete, anyOther, readonly, toolUseId]);

  const toggleOther = (index: number, multiSelect: boolean | undefined): void => {
    setOthers((current) => {
      const entry = current[index] ?? { active: false, text: '' };
      return {
        ...current,
        [index]: multiSelect ? { ...entry, active: !entry.active } : { ...entry, active: true },
      };
    });
    if (!multiSelect) {
      setSelections((current) => ({ ...current, [index]: [] }));
    }
  };

  const setOtherText = (index: number, text: string): void => {
    setOthers((current) => ({
      ...current,
      [index]: { active: current[index]?.active ?? true, text },
    }));
  };

  return (
    <div className="block-question">
      <div className="block-title">需要你的回答</div>
      {questions.map((question, index) => {
        const other = others[index] ?? { active: false, text: '' };
        return (
        <div key={index} className="question">
          {question.header && <div className="question-header">{question.header}</div>}
          <div className="question-text">{question.question}</div>
          <div className="question-options">
            {question.options.map((option) => {
              const checked = (selections[index] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`question-option${checked ? ' selected' : ''}`}
                  aria-pressed={checked}
                  disabled={answered || readonly}
                  onClick={() => {
                    setSelections((current) =>
                      toggleSelection(current, index, option.label, question.multiSelect),
                    );
                    if (!question.multiSelect) {
                      setOthers((current) => ({
                        ...current,
                        [index]: { active: false, text: '' },
                      }));
                    }
                  }}
                >
                  <span className="question-mark">
                    {question.multiSelect ? (checked ? '☑' : '☐') : checked ? '◉' : '○'}
                  </span>
                  <span className="question-option-text">
                    <span className="question-label">{option.label}</span>
                    {option.description && <span className="question-desc">{option.description}</span>}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={`question-option${other?.active ? ' selected' : ''}`}
              aria-pressed={other?.active === true}
              disabled={answered || readonly}
              onClick={() => toggleOther(index, question.multiSelect)}
            >
              <span className="question-mark">
                {question.multiSelect ? (other?.active ? '☑' : '☐') : other?.active ? '◉' : '○'}
              </span>
              <span className="question-option-text">
                <span className="question-label">其他</span>
                <span className="question-desc">自己输入答案</span>
              </span>
            </button>
            {other?.active && (
              <input
                className="question-other-input"
                type="text"
                value={other.text}
                placeholder="输入你的答案"
                disabled={answered || readonly}
                onChange={(event) => setOtherText(index, event.target.value)}
              />
            )}
          </div>
        </div>
        );
      })}
      {answered || answerStatus === 'allowed' ? (
        <div className="question-status">
          {/* The picks are marked above; naming them in text as well is what
              makes a replayed card readable at a glance. */}
          {answeredSummary(questions, selections, others) ?? '已发送答案'}
        </div>
      ) : answerStatus === 'denied' ? (
        <div className="question-status">已回答拒绝；助手会自行处理。</div>
      ) : answerStatus === 'timed_out' ? (
        <div className="question-status">超时未回答；助手会自行处理。</div>
      ) : readonly ? (
        <div className="question-status">
          {closed
            ? '这次提问已结束（运行结束或超时），无法再回答。'
            : '这是历史提问，答案不会保留在对话里。'}
        </div>
      ) : (
        <>
          {(anyOther || blocking) && (
            <button
              type="button"
              className="btn primary"
              disabled={!complete}
              onClick={() =>
                answerQuestion(
                  toolUseId,
                  buildAnswerText(questions, selections, others),
                  buildStructuredAnswers(questions, selections, others),
                )
              }
            >
              发送答案
            </button>
          )}
          {busy && !blocking && !anyOther && (
            <div className="question-status">运行结束后自动发送所选答案</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 「你的选择：A、B」 for a settled card.
 *
 * Only text: the options above are already marked as picked, so this is the
 * one-line answer a user scanning the transcript actually reads. Returns null
 * when nothing was recorded (an older daemon, or a question answered in a form
 * we cannot attribute), in which case the caller falls back to the plain
 * "已发送答案".
 */
function answeredSummary(
  questions: QuestionDto[],
  selections: QuestionSelections,
  others: QuestionOthers,
): string | null {
  const parts: string[] = [];
  questions.forEach((_question, index) => {
    const picked = [...(selections[index] ?? [])];
    const typed = others[index];
    if (typed?.active && typed.text.trim()) picked.push(typed.text.trim());
    if (picked.length > 0) parts.push(picked.join('、'));
  });
  if (parts.length === 0) return null;
  return `你的选择：${parts.join('；')}`;
}
