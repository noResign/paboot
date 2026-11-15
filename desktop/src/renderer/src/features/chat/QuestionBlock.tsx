import { useEffect, useState } from 'react';
import { isBusy, useChat } from '../../store/chat';
import { buildAnswerText, isFullyAnswered, toggleSelection } from './questionAnswer';
import type { QuestionOthers, QuestionSelections } from './questionAnswer';
import type { QuestionDto } from '../../../../shared/contract';

interface Props {
  toolUseId: string;
  questions: QuestionDto[];
  answered: boolean;
  /** Builtin blocking question: answer while the run is still live. */
  permissionId?: string | null;
}

/**
 * An `AskUserQuestion` card. Headless Claude auto-denies the tool, so its answer
 * can only be a continuation turn after the run stops. Builtin blocks the run
 * instead (`permissionId`), so its answer is sent immediately and becomes the
 * tool result.
 */
export function QuestionBlock({ toolUseId, questions, answered, permissionId }: Props) {
  const busy = useChat((state) => {
    const chat = state.activeKey ? state.byKey[state.activeKey] : undefined;
    return chat ? isBusy(chat.phase) : false;
  });
  const answerQuestion = useChat((state) => state.answerQuestion);
  const [selections, setSelections] = useState<QuestionSelections>({});
  const [others, setOthers] = useState<QuestionOthers>({});

  // A recycled slot (the transcript keys segments by index) must not inherit the
  // previous question's picks.
  useEffect(() => {
    setSelections({});
    setOthers({});
  }, [toolUseId]);

  const anyOther = Object.values(others).some((entry) => entry.active);
  const complete = isFullyAnswered(questions, selections, others);
  const blocking = Boolean(permissionId);

  useEffect(() => {
    if (answered || !complete || anyOther) return;
    if (busy && !blocking) return;
    answerQuestion(toolUseId, buildAnswerText(questions, selections, others));
    // `selections` is read only through `complete`, which flips exactly when the
    // picks become sendable; depending on it directly would fire on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, busy, blocking, complete, anyOther, toolUseId]);

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
                  disabled={answered}
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
              disabled={answered}
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
                disabled={answered}
                onChange={(event) => setOtherText(index, event.target.value)}
              />
            )}
          </div>
        </div>
        );
      })}
      {answered ? (
        <div className="question-status">已发送答案</div>
      ) : (
        <>
          {anyOther && (
            <button
              type="button"
              className="btn primary"
              disabled={!complete}
              onClick={() =>
                answerQuestion(toolUseId, buildAnswerText(questions, selections, others))
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
