import { useState } from 'react';
import type { TodoItem } from '../../store/chat/types';
import { Icon } from '../../ui/Icon';

/** Completed rows keep their tick; the rest are plain status dots. */
function todoGlyph(status: string): React.ReactNode {
  if (status === 'completed') return <Icon name="check" size={12} />;
  return <span className="todo-dot" aria-hidden="true" />;
}

/** The agent's own task list (TodoWrite), kept out of the transcript. */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((todo) => todo.status === 'completed').length;
  // A fully finished list is historical noise: it would sit above every later
  // answer as a permanent strip saying "done". Only show work still in flight.
  if (todos.length === 0 || done === todos.length) return null;

  return (
    <div className="todo-panel">
      <button className="fold-head" onClick={() => setOpen((value) => !value)}>
        <span className="chevron">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
        <span>待办</span>
        <span className="badge">
          {done}/{todos.length}
        </span>
      </button>
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
