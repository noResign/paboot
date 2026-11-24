import { useState } from 'react';
import type { TodoItem } from '../../store/chat/types';
import { Icon } from '../../ui/Icon';
import { showTodoPanel, todoSignature } from './todoVisibility';
import { readTodoDismissal, writeTodoDismissal } from '../../store/todoDismissal';

/** Completed rows keep their tick; the rest are plain status dots. */
function todoGlyph(status: string): React.ReactNode {
  if (status === 'completed') return <Icon name="check" size={12} />;
  return <span className="todo-dot" aria-hidden="true" />;
}

/**
 * The agent's own task list (TodoWrite), kept out of the transcript.
 *
 * A list with work left in it stays up for as long as the agent keeps working —
 * which can be an hour, over a conversation the user has stopped reading. So it
 * is dismissible, and the dismissal outlives the app: coming back to the
 * conversation must not put the same strip in front of the user again. Only a
 * different list brings it back.
 */
export function TodoPanel({ todos, sessionId }: { todos: TodoItem[]; sessionId: string | null }) {
  const [open, setOpen] = useState(true);
  /**
   * The list the user put away, identified by its content.
   *
   * Read during the first render, never in an effect: an effect runs after
   * paint, so a session whose todos are already in memory would draw the strip
   * for one frame and then drop it — the closest thing to "it came back" that a
   * dismissal can produce. `ChatView` keys this component by session, so a
   * switch remounts it and this initializer is what reads the new session's
   * answer (an effect keyed on `sessionId` would also paint one frame of the
   * *previous* session's dismissal first).
   */
  const [dismissed, setDismissed] = useState<string | null>(() => readTodoDismissal(sessionId));

  const signature = todoSignature(todos);

  const dismiss = (): void => {
    setDismissed(signature);
    writeTodoDismissal(sessionId, signature);
  };

  if (!showTodoPanel(todos, dismissed)) return null;

  const done = todos.filter((todo) => todo.status === 'completed').length;

  return (
    <div className="todo-panel">
      <div className="todo-head">
        <button
          className="fold-head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="chevron">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
          <span>待办</span>
          <span className="badge">
            {done}/{todos.length}
          </span>
        </button>
        <button
          className="icon-btn"
          title="收起这条待办"
          aria-label="收起这条待办"
          onClick={dismiss}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      {open && (
        <ul className="todo-list">
          {todos.map((todo, index) => (
            <li key={`${index}-${todo.content}`} className={`todo-item ${todo.status}`}>
              <span className="todo-glyph">{todoGlyph(todo.status)}</span>
              <span>{todo.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
