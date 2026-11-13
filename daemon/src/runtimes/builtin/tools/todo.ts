import type { SessionTodoInput } from '../../../db/db.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord } from './file-utils.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const MAX_TODOS = 50;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export interface TodoToolOptions {
  /** Replace the session's list; returns nothing (the tool renders from input). */
  save: (sessionId: string, todos: readonly SessionTodoInput[]) => void;
}

/** Claude-compatible todo list replacement. */
export function createTodoTool(options: TodoToolOptions): ToolImplementation {
  const descriptor: ToolDescriptor = {
    name: 'TodoWrite',
    title: 'TodoWrite',
    description:
      'Replace the current session todo list. Use for multi-step work; exactly one item should be in_progress.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string' },
            },
            required: ['content', 'status', 'activeForm'],
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'control',
    concurrencySafe: false,
    timeoutMs: 10_000,
  };

  return {
    descriptor,
    call(input: unknown, context: ToolCallContext): ToolResult {
      const todos = parseTodos(input);
      const sessionId = context.agent.sessionId;
      if (!sessionId) {
        throw new ToolError('todos require a session', 'todo_unavailable');
      }
      options.save(sessionId, todos);
      return {
        content: todos.length === 0
          ? 'Todo list cleared.'
          : `Updated todos:\n${todos
              .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
              .join('\n')}`,
        isError: false,
        meta: { count: todos.length },
      };
    },
  };
}

function parseTodos(input: unknown): SessionTodoInput[] {
  if (!isRecord(input) || !Array.isArray(input['todos'])) {
    throw new ToolError('todos must be an array', 'todo_invalid_input');
  }
  const raw = input['todos'];
  if (raw.length > MAX_TODOS) {
    throw new ToolError(`at most ${MAX_TODOS} todos are allowed`, 'todo_invalid_input');
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new ToolError(`todo ${index + 1} must be an object`, 'todo_invalid_input');
    const content = item['content'];
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ToolError(`todo ${index + 1}: content must be a non-empty string`, 'todo_invalid_input');
    }
    const status = item['status'];
    if (typeof status !== 'string' || !STATUSES.has(status)) {
      throw new ToolError(`todo ${index + 1}: invalid status`, 'todo_invalid_input');
    }
    const activeForm = item['activeForm'];
    if (activeForm !== undefined && typeof activeForm !== 'string') {
      throw new ToolError(`todo ${index + 1}: activeForm must be a string`, 'todo_invalid_input');
    }
    return {
      content,
      status: status as SessionTodoInput['status'],
      activeForm: typeof activeForm === 'string' ? activeForm : content,
    };
  });
}
