import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../src/runtimes/builtin/types';
import {
  createAskUserQuestionTool,
  type QuestionExchange,
  type QuestionOutcome,
} from '../src/runtimes/builtin/tools/ask-user-question';
import type { ToolCallContext } from '../src/runtimes/builtin/tools/types';

const questions = [
  {
    question: 'Which database?',
    header: 'DB',
    multiSelect: false,
    options: [
      { label: 'SQLite' },
      { label: 'Postgres', description: 'Server-backed' },
    ],
  },
];

function context(events: AgentEvent[], signal = new AbortController().signal): ToolCallContext {
  return {
    callId: 'call-1',
    signal,
    agent: { eventSink: { emit: (event) => events.push(event) } },
  } as unknown as ToolCallContext;
}

function exchange(outcome: QuestionOutcome, seen: { questions?: unknown; permissionId?: string } = {}): QuestionExchange {
  return {
    create(input) {
      seen.questions = input;
      return 'perm-1';
    },
    async wait(permissionId) {
      seen.permissionId = permissionId;
      return outcome;
    },
  };
}

describe('AskUserQuestion tool', () => {
  it('emits a question event and returns the answer as the tool result', async () => {
    const events: AgentEvent[] = [];
    const seen: { questions?: unknown; permissionId?: string } = {};
    const tool = createAskUserQuestionTool(
      exchange({ status: 'allowed', answer: 'SQLite' }, seen),
    );

    const result = await tool.call({ questions }, context(events));

    const parsedQuestions = [{ id: 'q0', ...questions[0] }];
    expect(seen.permissionId).toBe('perm-1');
    expect(seen.questions).toEqual(parsedQuestions);
    expect(result).toEqual({ content: '用户回答：\nSQLite', isError: false });
    expect(events).toContainEqual({
      type: 'question',
      toolUseId: 'call-1',
      questions: parsedQuestions,
      permissionId: 'perm-1',
    });
  });

  it('reports denial and timeout as tool errors', async () => {
    const denied = createAskUserQuestionTool(exchange({ status: 'denied', answer: null }));
    await expect(denied.call({ questions }, context([]))).resolves.toMatchObject({
      isError: true,
    });

    const timedOut = createAskUserQuestionTool(exchange({ status: 'timed_out', answer: null }));
    await expect(timedOut.call({ questions }, context([]))).resolves.toMatchObject({
      isError: true,
    });
  });

  it('marks an aborted wait as interrupted', async () => {
    const controller = new AbortController();
    const tool = createAskUserQuestionTool({
      create: () => 'perm-1',
      async wait() {
        controller.abort();
        return { status: 'denied', answer: null };
      },
    });
    const result = await tool.call({ questions }, context([], controller.signal));
    expect(result).toMatchObject({ isError: true, interrupted: true });
  });

  it('validates the question shape', async () => {
    const tool = createAskUserQuestionTool(exchange({ status: 'denied', answer: null }));
    await expect(
      tool.call({ questions: [{ question: 'only one option', options: [{ label: 'A' }] }] }, context([])),
    ).rejects.toThrow('2-4 items');
    await expect(tool.call({ questions: [] }, context([]))).rejects.toThrow('1-4 items');
  });
});
