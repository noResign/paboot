import type { EventRow, MessageRow } from '../db/db.js';
import { filterCaptureText } from './capture-filter.js';
import type { MemoryRunScope } from './scope-resolver.js';
import type { MemoryStore } from './store.js';
import type {
  MemoryObservation,
  MemorySessionSummary,
  ObservationType,
} from './types.js';

export interface CaptureObservationInput {
  store: MemoryStore;
  scope: MemoryRunScope;
  messages: readonly MessageRow[];
  toolEvents: readonly EventRow[];
}

export interface CaptureObservationResult {
  observation: MemoryObservation | null;
  summary: MemorySessionSummary | null;
}

interface ToolFiles {
  filesRead: string[];
  filesModified: string[];
}

const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Mechanical L0.5 capture. This is the provider-independent baseline: the
 * visible run text becomes one `turn` observation and one session summary,
 * and file lists come from structured tool events (never guessed from Bash).
 * A later LLM compression pass can refine the same rows.
 */
export function captureRunObservation(input: CaptureObservationInput): CaptureObservationResult {
  const request = firstUserText(input.messages);
  const completed = lastAssistantText(input.messages);
  if (request === '' && completed === '') return { observation: null, summary: null };

  const tool = extractToolFiles(input.toolEvents);
  const source = input.store.findSourceForRun(input.scope.scope, input.scope.runId ?? '');
  const title = compact(request || completed, 120);
  const observation = input.store.upsertObservation({
    scope: input.scope.scope,
    endId: input.scope.endId,
    sessionId: input.scope.sessionId,
    runId: input.scope.runId,
    sourceId: source?.id ?? null,
    kind: 'turn',
    type: inferType(request, completed, tool),
    title,
    subtitle: completed === '' ? null : compact(firstLine(completed), 160),
    facts: [request, completed].filter((text) => text !== '').map((text) => compact(text, 300)),
    narrative: completed === '' ? null : compact(completed, 4000),
    concepts: inferConcepts(completed, tool),
    filesRead: tool.filesRead,
    filesModified: tool.filesModified,
    evidence:
      input.scope.runId === null
        ? []
        : [{ runId: input.scope.runId, seq: input.toolEvents[0]?.seq ?? 0 }],
  }).observation;

  const summary = input.store.upsertSessionSummary({
    scope: input.scope.scope,
    endId: input.scope.endId,
    sessionId: input.scope.sessionId,
    runId: input.scope.runId,
    request: compact(request, 2000),
    completed: compact(completed, 4000),
    filesRead: tool.filesRead,
    filesEdited: tool.filesModified,
  });

  return { observation, summary };
}

/** Structured file tools only; Bash stays empty rather than guessing. */
export function extractToolFiles(events: readonly EventRow[]): ToolFiles {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      continue;
    }
    if (payload === null || typeof payload !== 'object') continue;
    const record = payload as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const args = record['input'];
    if (args === null || typeof args !== 'object') continue;
    const input = args as Record<string, unknown>;
    const file =
      typeof input['file_path'] === 'string'
        ? input['file_path']
        : typeof input['notebook_path'] === 'string'
          ? input['notebook_path']
          : null;
    if (!file) continue;
    if (READ_TOOLS.has(name)) read.add(file);
    else if (WRITE_TOOLS.has(name)) modified.add(file);
  }
  return { filesRead: [...read], filesModified: [...modified] };
}

function firstUserText(messages: readonly MessageRow[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = filterCaptureText(message.content).trim();
    if (text !== '') return text;
  }
  return '';
}

function lastAssistantText(messages: readonly MessageRow[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const text = filterCaptureText(message.content).trim();
    if (text !== '') return text;
  }
  return '';
}

function inferType(
  request: string,
  completed: string,
  files: ToolFiles,
): ObservationType {
  const text = `${request}\n${completed}`;
  if (/修复|bug|fix|报错|失败|regression/i.test(text)) return 'bugfix';
  if (/重构|refactor|拆分|整理/i.test(text)) return 'refactor';
  if (/决定|决策|decide|decision|方案/i.test(text)) return 'decision';
  if (/新增|添加|实现|feature|add\s/i.test(text)) return 'feature';
  if (files.filesModified.length > 0) return 'change';
  return 'discovery';
}

function inferConcepts(completed: string, files: ToolFiles): string[] {
  const concepts: string[] = [];
  if (files.filesModified.length > 0) concepts.push('what-changed');
  if (/注意|坑|gotcha|trap/i.test(completed)) concepts.push('gotcha');
  return concepts;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length <= max ? normalized : `${chars.slice(0, max - 1).join('')}…`;
}
