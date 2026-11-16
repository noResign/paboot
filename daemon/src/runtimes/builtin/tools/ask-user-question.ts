import type { QuestionDto } from '../../../types/api.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord } from './file-utils.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

export interface QuestionOutcome {
  status: 'allowed' | 'denied' | 'timed_out';
  answer: string | null;
}

/** Blocking question channel: create a pending answer slot, then wait for it. */
export interface QuestionExchange {
  create(questions: QuestionDto[]): string;
  wait(permissionId: string, signal: AbortSignal): Promise<QuestionOutcome>;
}

/**
 * `AskUserQuestion`: renders the same question card as Claude and blocks the
 * run until the operator answers (Codex-style), so the answer becomes this
 * call's tool result and the model continues in the same run.
 */
export function createAskUserQuestionTool(exchange: QuestionExchange): ToolImplementation {
  const descriptor: ToolDescriptor = {
    name: 'AskUserQuestion',
    title: 'AskUserQuestion',
    description:
      'Ask the user one or more multiple-choice questions and wait for the answer. ' +
      'Use it only when a decision is genuinely required from the user.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'control',
    concurrencySafe: false,
    timeoutMs: 120_000,
  };

  return {
    descriptor,
    async call(input: unknown, context: ToolCallContext): Promise<ToolResult> {
      const questions = parseQuestions(input);
      const permissionId = exchange.create(questions);
      context.agent.eventSink.emit({
        type: 'question',
        toolUseId: context.callId,
        questions,
        permissionId,
      });
      const outcome = await exchange.wait(permissionId, context.signal);
      if (context.signal.aborted) {
        return { content: '用户未回答（运行已取消）。', isError: true, interrupted: true };
      }
      if (outcome.status === 'allowed' && outcome.answer) {
        return { content: `用户回答：\n${outcome.answer}`, isError: false };
      }
      return {
        content:
          outcome.status === 'timed_out'
            ? '用户未在超时前回答。请自行做出合理选择，或说明需要用户确认。'
            : '用户拒绝回答这个问题。请自行做出合理选择，或说明需要用户确认。',
        isError: true,
      };
    },
  };
}

function parseQuestions(input: unknown): QuestionDto[] {
  if (!isRecord(input) || !Array.isArray(input['questions'])) {
    throw new ToolError('questions must be a non-empty array', 'invalid_input');
  }
  const raw = input['questions'];
  if (raw.length === 0 || raw.length > 4) {
    throw new ToolError('questions must contain 1-4 items', 'invalid_input');
  }
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new ToolError(`questions[${index}] must be an object`, 'invalid_input');
    const question = entry['question'];
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new ToolError(`questions[${index}].question must be a non-empty string`, 'invalid_input');
    }
    const options = entry['options'];
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
      throw new ToolError(`questions[${index}].options must contain 2-4 items`, 'invalid_input');
    }
    const parsedOptions = options.map((option, optionIndex) => {
      if (!isRecord(option) || typeof option['label'] !== 'string' || option['label'].trim().length === 0) {
        throw new ToolError(
          `questions[${index}].options[${optionIndex}].label must be a non-empty string`,
          'invalid_input',
        );
      }
      const description = option['description'];
      return {
        label: option['label'].trim(),
        ...(typeof description === 'string' && description.trim().length > 0
          ? { description: description.trim() }
          : {}),
      };
    });
    const header = entry['header'];
    const multiSelect = entry['multiSelect'];
    return {
      // The model never supplies ids; clients key structured answers by them.
      id: `q${index}`,
      question: question.trim(),
      ...(typeof header === 'string' && header.trim().length > 0 ? { header: header.trim() } : {}),
      ...(typeof multiSelect === 'boolean' ? { multiSelect } : {}),
      options: parsedOptions,
    };
  });
}
