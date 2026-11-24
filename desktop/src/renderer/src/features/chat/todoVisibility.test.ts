import { describe, expect, it } from 'vitest';
import { showTodoPanel, todoSignature } from './todoVisibility';
import type { TodoItem } from '../../store/chat/types';

function todo(content: string, status: string): TodoItem {
  return { content, status } as TodoItem;
}

const inFlight: TodoItem[] = [
  todo('读代码', 'completed'),
  todo('改实现', 'in_progress'),
  todo('跑测试', 'pending'),
];

describe('showTodoPanel', () => {
  it('shows a list with work left', () => {
    expect(showTodoPanel(inFlight, null)).toBe(true);
  });

  it('hides an empty list and a fully finished one', () => {
    expect(showTodoPanel([], null)).toBe(false);
    // A finished list would sit above every later answer saying "done" forever.
    expect(showTodoPanel([todo('读代码', 'completed')], null)).toBe(false);
  });

  it('stays hidden after the user puts it away', () => {
    expect(showTodoPanel(inFlight, todoSignature(inFlight))).toBe(false);
  });

  it('stays hidden while only statuses move', () => {
    // The agent ticking an item off is progress on the same list, not a new
    // one: bringing the strip back is exactly what dismissing it stopped.
    const dismissed = todoSignature(inFlight);
    const progressed = [
      todo('读代码', 'completed'),
      todo('改实现', 'completed'),
      todo('跑测试', 'in_progress'),
    ];
    expect(todoSignature(progressed)).toBe(dismissed);
    expect(showTodoPanel(progressed, dismissed)).toBe(false);
  });

  it('comes back when the agent writes a different list', () => {
    const dismissed = todoSignature(inFlight);
    const rewritten = [...inFlight, todo('补文档', 'pending')];
    expect(todoSignature(rewritten)).not.toBe(dismissed);
    expect(showTodoPanel(rewritten, dismissed)).toBe(true);
  });

  it('a finished dismissed list stays hidden even when rewritten is empty', () => {
    // Defensive: clearing the list must not un-dismiss anything.
    const dismissed = todoSignature(inFlight);
    expect(showTodoPanel([], dismissed)).toBe(false);
  });
});
