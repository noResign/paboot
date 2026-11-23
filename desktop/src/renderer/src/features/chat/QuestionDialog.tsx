import { QuestionBlock } from './QuestionBlock';
import { agentDisplayName } from './agentLabel';
import type { LiveAnswer } from './liveAnswers';
import type { SessionAgentDto } from '../../../../shared/contract';

interface Props {
  answer: LiveAnswer;
  /** Who is asking, for the title. Falls back to a neutral word. */
  agentName: string | null;
  onClose(): void;
}

/**
 * A blocking question, surfaced where the user is actually looking.
 *
 * The live-card copy in the assistant tab is correct but easy to miss: it sits
 * in a tab the user may never open, and the status strip above the composer is
 * one quiet line. A blocking question stops the whole run, so the honest place
 * for it is on top of the conversation — with a dismiss affordance, because
 * answering may need a look at the transcript first.
 *
 * The card itself is the same component the transcript uses, so both surfaces
 * cannot drift apart (options, 「其他」, answer replay).
 */
export function QuestionDialog({ answer, agentName, onClose }: Props) {
  const blocks = answer.message.blocks.filter((block) => block.kind === 'question');
  const questions = blocks.flatMap((block) => (block.kind === 'question' ? block.questions : []));
  const first = blocks.find((block) => block.kind === 'question');
  if (!first || first.kind !== 'question') return null;

  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal question-modal" role="dialog" aria-modal="true" aria-label="需要你的回答">
        <div className="question-modal-head">
          <b>{agentName ? `${agentName} 需要你的回答` : '需要你的回答'}</b>
          <button className="icon-btn" title="稍后回答" aria-label="稍后回答" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="question-modal-hint">
          助手正在等这个答案，回答前它不会继续。
        </p>
        <QuestionBlock
          toolUseId={first.toolUseId}
          questions={questions}
          answered={first.answered}
          answerStatus={first.answerStatus ?? null}
          answers={first.answers ?? null}
          answerText={first.answerText ?? null}
          permissionId={first.permissionId}
          interactive
        />
      </div>
    </div>
  );
}

/** Display name for the asking agent, given the two rosters the chat page holds. */
export function askerName(
  answer: LiveAnswer,
  sessionAgents: readonly SessionAgentDto[],
  workspaceAgents: readonly { id: string; name: string }[],
): string | null {
  if (!answer.agentId) return null;
  const member = sessionAgents.find((agent) => agent.id === answer.agentId);
  if (member) return agentDisplayName(member);
  return workspaceAgents.find((agent) => agent.id === answer.agentId)?.name ?? null;
}
