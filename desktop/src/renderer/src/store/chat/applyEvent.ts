import type { ContextUsage } from '../../../../shared/format';
import type { NormalizedEvent, SseFrame } from '../../../../shared/contract';
import type { ChatMessage, ContentBlock, TodoItem, UsageInfo } from './types';

/**
 * The frame → state reducer, kept pure and framework-free so the parts that are
 * easiest to get wrong (usage accumulation, context tracking, tool pairing,
 * interruption synthesis) are covered by tests rather than by staring at the UI.
 * One implementation serves both the live stream and history replay, so the two
 * can never drift.
 */
export interface FrameState {
  messages: ChatMessage[];
  todos: TodoItem[];
  contextUsage: ContextUsage | null;
  /** A terminal `status`/`error` ended this run. */
  terminal: boolean;
  /** The terminal status was `succeeded` — see invariant 5. */
  terminalSucceeded: boolean;
}

export type AssistantMessage = Extract<ChatMessage, { kind: 'assistant' }>;

export function newAssistant(id: string): AssistantMessage {
  return { kind: 'assistant', id, blocks: [], usage: null, error: null, done: false };
}

export function applyFrame(state: FrameState, frame: SseFrame, makeId: () => string): FrameState {
  const event = frame.event;

  // TodoWrite is a side channel, not a tool call the user should read in the
  // transcript — it feeds the todo panel instead.
  if (event.type === 'tool_use' && event.name === 'TodoWrite') {
    return { ...state, todos: parseTodos(event.input) };
  }

  const contextUsage = trackContext(state.contextUsage, event);
  let messages = applyToLastAssistant(state.messages, event, makeId);
  const terminal = isTerminal(event);
  const terminalSucceeded = event.type === 'status' && event.terminal === true && event.label === 'succeeded';

  // Invariant 5: a non-terminal error mid-run (Codex occasionally emits one)
  // must not leave red text on an answer that ultimately succeeded.
  if (terminalSucceeded) messages = clearLastAssistantError(messages);

  return { ...state, messages, contextUsage, terminal, terminalSucceeded };
}

/** Fold a whole run's events into one assistant message (history replay). */
export function buildAssistantFromEvents(
  frames: SseFrame[],
  makeId: () => string,
): { assistant: AssistantMessage; todos: TodoItem[]; contextUsage: ContextUsage | null } {
  let state: FrameState = {
    messages: [newAssistant(makeId())],
    todos: [],
    contextUsage: null,
    terminal: false,
    terminalSucceeded: false,
  };
  for (const frame of frames) {
    // Approvals are transient: replaying them would resurrect a resolved popup.
    if (frame.event.type === 'permission_request') continue;
    state = applyFrame(state, frame, makeId);
  }
  return {
    assistant: finalizeAssistant(lastAssistant(state.messages) ?? newAssistant(makeId())),
    todos: state.todos,
    contextUsage: state.contextUsage,
  };
}

function applyToLastAssistant(
  messages: ChatMessage[],
  event: NormalizedEvent,
  makeId: () => string,
): ChatMessage[] {
  const index = lastAssistantIndex(messages);
  const base = index < 0 ? [...messages, newAssistant(makeId())] : messages;
  const target = index < 0 ? base.length - 1 : index;
  const current = base[target];
  if (!current || current.kind !== 'assistant') return base;
  const next = [...base];
  next[target] = applyEvent(current, event);
  return next;
}

/** Per-event update of a single assistant message. */
export function applyEvent(a: AssistantMessage, event: NormalizedEvent): AssistantMessage {
  switch (event.type) {
    case 'status':
      return event.terminal === true ? finalizeAssistant(a) : a;
    case 'text_delta':
      return { ...a, blocks: appendText(endThinking(a.blocks), event.delta) };
    // Thinking content is no longer sent. An older daemon may still stream it,
    // so keep its card alive without storing the text.
    case 'thinking_delta':
      return { ...a, blocks: keepThinking(a.blocks) };
    case 'thinking_start':
      return { ...a, blocks: [...endThinking(a.blocks), { kind: 'thinking', active: true }] };
    case 'tool_use':
      return {
        ...a,
        blocks: [
          ...endThinking(a.blocks),
          {
            kind: 'tool',
            id: event.id,
            name: event.name,
            input: event.input,
            result: null,
            isError: false,
            interrupted: false,
            running: true,
          },
        ],
      };
    case 'tool_result':
      return {
        ...a,
        blocks: endThinking(a.blocks).map((block) =>
          block.kind === 'tool' && block.id === event.toolUseId
            ? {
                ...block,
                result: event.content,
                isError: event.isError === true,
                interrupted: event.interrupted === true,
                running: false,
              }
            : block,
        ),
      };
    case 'usage':
      // Invariant 1: a frame without usage numbers must not clear the last one.
      // Usage lands on a model-turn boundary, i.e. after the thinking block ended.
      return { ...a, blocks: endThinking(a.blocks), usage: parseUsage(event) ?? a.usage };
    case 'turn_end':
      return { ...a, blocks: endThinking(a.blocks) };
    case 'error':
      return { ...a, error: event.message, blocks: endThinking(a.blocks) };
    case 'permission_request':
      return { ...a, blocks: endThinking(a.blocks) };
    case 'question':
      return {
        ...a,
        blocks: [...endThinking(a.blocks), { kind: 'question', toolUseId: event.toolUseId, questions: event.questions, answered: false }],
      };
  }
}

/** Visible content or a turn boundary stops the trailing thinking card's spinner. */
function endThinking(blocks: ContentBlock[]): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind !== 'thinking' || !last.active) return blocks;
  return [...blocks.slice(0, -1), { ...last, active: false }];
}

/** Keep a card alive for an older daemon that still streams thinking deltas. */
function keepThinking(blocks: ContentBlock[]): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'thinking') {
    return last.active ? blocks : [...blocks.slice(0, -1), { ...last, active: true }];
  }
  return [...blocks, { kind: 'thinking', active: true }];
}

/**
 * Invariant 4: closing a turn marks any still-running tool as interrupted.
 *
 * The daemon also synthesizes an `interrupted` result when a run ends, but when
 * the user hits stop we have already aborted the socket and never read that
 * frame — so the local close must produce the same visual state, or the card
 * spins forever.
 */
export function finalizeAssistant(a: AssistantMessage): AssistantMessage {
  const blocks = endThinking(a.blocks);
  if (a.done && !blocks.some((block) => block.kind === 'tool' && block.running)) {
    return blocks === a.blocks ? a : { ...a, blocks };
  }
  return {
    ...a,
    done: true,
    blocks: blocks.map((block) =>
      block.kind === 'tool' && block.running ? { ...block, running: false, interrupted: true } : block,
    ),
  };
}

/**
 * Invariant 2: context occupancy only moves when a frame actually carries it,
 * and a frame without the field means "no information", never zero.
 */
export function trackContext(current: ContextUsage | null, event: NormalizedEvent): ContextUsage | null {
  if (event.type !== 'usage') return current;
  const tokens = event.contextTokens;
  if (tokens === undefined || tokens === null) return current;
  return { tokens, window: event.contextWindow ?? null };
}

export function parseUsage(event: Extract<NormalizedEvent, { type: 'usage' }>): UsageInfo | null {
  const raw = event.usage;
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const inputTokens = numberOf(record?.['input_tokens']);
  const outputTokens = numberOf(record?.['output_tokens']);
  const costUsd = typeof event.costUsd === 'number' ? event.costUsd : null;
  if (inputTokens === null && outputTokens === null && costUsd === null) return null;
  return { inputTokens, outputTokens, costUsd };
}

export function parseTodos(input: unknown): TodoItem[] {
  const record = input && typeof input === 'object' ? (input as { todos?: unknown }) : null;
  if (!Array.isArray(record?.todos)) return [];
  const todos: TodoItem[] = [];
  for (const entry of record.todos) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { content?: unknown; status?: unknown };
    if (typeof item.content !== 'string') continue;
    todos.push({ content: item.content, status: typeof item.status === 'string' ? item.status : 'pending' });
  }
  return todos;
}

export function appendText(blocks: ContentBlock[], delta: string): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'text') return [...blocks.slice(0, -1), { kind: 'text', text: last.text + delta }];
  return [...blocks, { kind: 'text', text: delta }];
}

export function isTerminal(event: NormalizedEvent): boolean {
  if (event.type === 'status') return event.terminal === true;
  if (event.type === 'error') return event.terminal === true;
  return false;
}

export function lastAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'assistant') return i;
  }
  return -1;
}

export function lastAssistant(messages: ChatMessage[]): AssistantMessage | null {
  const index = lastAssistantIndex(messages);
  const message = index < 0 ? undefined : messages[index];
  return message?.kind === 'assistant' ? message : null;
}

/** Finalize the trailing assistant message, if any. */
export function finalizeLast(messages: ChatMessage[]): ChatMessage[] {
  const index = lastAssistantIndex(messages);
  const message = index < 0 ? undefined : messages[index];
  if (!message || message.kind !== 'assistant') return messages;
  const next = [...messages];
  next[index] = finalizeAssistant(message);
  return next;
}

function clearLastAssistantError(messages: ChatMessage[]): ChatMessage[] {
  const index = lastAssistantIndex(messages);
  const message = index < 0 ? undefined : messages[index];
  if (!message || message.kind !== 'assistant' || message.error === null) return messages;
  const next = [...messages];
  next[index] = { ...message, error: null };
  return next;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
