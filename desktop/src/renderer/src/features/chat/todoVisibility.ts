import type { TodoItem } from '../../store/chat/types';

// Deliberately not `todoPanel.ts`: on a case-insensitive filesystem (macOS,
// Windows) `./TodoPanel` would resolve to this file before `TodoPanel.tsx`
// (`.ts` is tried before `.tsx`), and the component would import nothing.

/**
 * Identity of a todo list, for "has this changed since the user put it away?".
 *
 * Content only, deliberately not status: an agent ticking one item off while
 * the user has the strip dismissed must not bring it back. What should bring it
 * back is the agent writing a different list — that is new information.
 */
export function todoSignature(todos: readonly TodoItem[]): string {
  return todos.map((todo) => todo.content).join('\n');
}

/**
 * Whether the todo strip should be on screen.
 *
 * It is not a status indicator: a list with unfinished work can stay up for the
 * whole run, over a conversation the user has moved on from. So the user can
 * dismiss it, and only a changed list or a different conversation revives it.
 */
export function showTodoPanel(
  todos: readonly TodoItem[],
  dismissed: string | null,
): boolean {
  if (todos.length === 0) return false;
  // A fully finished list is history: showing it permanently above every later
  // answer says "done" forever.
  const done = todos.filter((todo) => todo.status === 'completed').length;
  if (done === todos.length) return false;
  if (dismissed !== null && dismissed === todoSignature(todos)) return false;
  return true;
}
