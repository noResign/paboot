import type { LlmProvider } from '../../llm/types.js';
import { log } from '../../platform/log.js';
import type { NativeCompaction, NativeMessage } from '../../types/transcript.js';
import type { BuiltinRuntimeConfig } from './config.js';
import type { TranscriptStore } from './transcript/store.js';

export type CompactionSettings = BuiltinRuntimeConfig['context']['compaction'];

export interface KeepBoundary {
  /** Index of the first message that stays verbatim. */
  keepStartIndex: number;
  /** Seq of the last message before the kept suffix; 0 when nothing is old enough. */
  throughSeq: number;
  /** Estimated tokens in the older prefix. */
  olderTokens: number;
}

export interface CompactionPlan {
  throughSeq: number;
  messagesToSummarize: NativeMessage[];
  tokensBefore: number;
}

/** A real user prompt starts a turn; tool results and runtime snapshots do not. */
function isTurnStart(message: NativeMessage): boolean {
  return message.role === 'user' && message.source.kind === 'user';
}

/** Same sizing rules as the neutral request estimator (see tokens.ts). */
function messageTokens(message: NativeMessage, measure: (text: string) => number): number {
  let tokens = 4;
  for (const block of message.blocks) {
    tokens += 4;
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += measure(block.text);
        break;
      case 'tool_call':
        tokens += measure(block.id) + measure(block.name) + measure(block.arguments);
        break;
      case 'tool_result':
        tokens += measure(block.content);
        break;
      case 'image':
        break;
    }
  }
  return tokens;
}

function rangeTokens(
  messages: readonly NativeMessage[],
  start: number,
  end: number,
  measure: (text: string) => number,
): number {
  let tokens = 0;
  for (let index = start; index < end; index += 1) {
    tokens += messageTokens(messages[index]!, measure);
  }
  return tokens;
}

/**
 * Walk turns from the newest backwards and keep roughly `keepRecentTokens` of
 * them verbatim. The current turn is always kept whole; the cut never splits an
 * assistant tool call from its tool results.
 */
export function findKeepBoundary(
  messages: readonly NativeMessage[],
  keepRecentTokens: number,
  measure: (text: string) => number,
): KeepBoundary | null {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isTurnStart(messages[index]!)) starts.push(index);
  }
  if (starts.length === 0) return null;

  let keepStartIndex = starts[starts.length - 1]!;
  let keptTokens = rangeTokens(messages, keepStartIndex, messages.length, measure);
  for (let turn = starts.length - 2; turn >= 0; turn -= 1) {
    if (keptTokens >= keepRecentTokens) break;
    keepStartIndex = starts[turn]!;
    keptTokens = rangeTokens(messages, keepStartIndex, messages.length, measure);
  }

  const throughSeq = keepStartIndex > 0 ? messages[keepStartIndex - 1]!.seq : 0;
  return {
    keepStartIndex,
    throughSeq,
    olderTokens: rangeTokens(messages, 0, keepStartIndex, measure),
  };
}

/** Decide whether the older prefix is worth a summary call. */
export function planCompaction(
  messages: readonly NativeMessage[],
  keepRecentTokens: number,
  minCompactTokens: number,
  measure: (text: string) => number,
): CompactionPlan | null {
  const boundary = findKeepBoundary(messages, keepRecentTokens, measure);
  if (!boundary || boundary.throughSeq === 0) return null;
  if (boundary.olderTokens < minCompactTokens) return null;

  // Runtime-context snapshots are environment state, not conversation: keep
  // them out of the summary body (they are re-added when they change).
  const messagesToSummarize = messages
    .slice(0, boundary.keepStartIndex)
    .filter((message) => message.source.kind !== 'runtime-context');
  if (messagesToSummarize.length === 0) return null;

  return {
    throughSeq: boundary.throughSeq,
    messagesToSummarize,
    tokensBefore: boundary.olderTokens,
  };
}

const SUMMARY_SYSTEM = [
  'You compress the earlier part of a coding-agent conversation so it can be',
  'continued without the full history. Preserve: the user goals and constraints,',
  'decisions made, files and commands touched, errors hit and how they were',
  'resolved, and any unfinished work. Drop greetings, repeated explanations and',
  'raw tool output. Write terse bullet points grouped by topic. Output only the',
  'summary text, in the language the conversation mostly uses.',
].join(' ');

export interface SummarizeCompactionInput {
  transcript: TranscriptStore;
  threadId: string;
  provider: LlmProvider;
  model: string;
  plan: CompactionPlan;
  previous: NativeCompaction | null;
  settings: CompactionSettings;
  measure: (text: string) => number;
  signal: AbortSignal;
}

/**
 * Ask the same provider for a summary and persist it. A failed summary must
 * never fail the run: callers keep using the uncompacted history.
 */
export async function summarizeCompaction(
  input: SummarizeCompactionInput,
): Promise<NativeCompaction | null> {
  const body = renderSummaryInput(input.plan.messagesToSummarize, input.previous?.summary ?? null);
  let summary: string;
  try {
    const completion = await input.provider.complete({
      provider: input.provider.id,
      model: input.model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: body }],
      tools: [],
      maxTokens: input.settings.maxSummaryTokens,
      temperature: 0,
      signal: input.signal,
    });
    summary = completion.text.trim();
  } catch (error) {
    log.warn(
      `builtin compaction request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (!summary) {
    log.warn('builtin compaction returned an empty summary; keeping history uncompacted');
    return null;
  }
  try {
    return input.transcript.appendCompaction({
      threadId: input.threadId,
      prevId: input.previous?.id ?? null,
      summary,
      throughSeq: input.plan.throughSeq,
      tokensBefore: input.plan.tokensBefore,
      tokensAfter: input.measure(summary),
    });
  } catch (error) {
    log.warn(
      `builtin compaction could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

const MAX_BLOCK_CHARS = 1_200;

function renderSummaryInput(messages: readonly NativeMessage[], previous: string | null): string {
  const parts: string[] = [];
  if (previous) {
    parts.push(`Summary of even earlier conversation:\n${previous}`);
  }
  for (const message of messages) {
    for (const block of message.blocks) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) {
            parts.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${truncate(block.text)}`);
          }
          break;
        case 'tool_call':
          parts.push(`Tool call ${block.name}(${truncate(block.arguments, 400)})`);
          break;
        case 'tool_result':
          parts.push(`Tool result: ${truncate(block.content)}`);
          break;
        case 'image':
          parts.push(`[image ${block.mediaType} ${block.width}x${block.height}]`);
          break;
        case 'reasoning':
          break;
      }
    }
  }
  return parts.join('\n\n');
}

function truncate(text: string, limit = MAX_BLOCK_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} chars omitted]`;
}
