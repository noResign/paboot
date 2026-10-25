import type { NormalizedEvent } from '../../types/api.js';

/**
 * Pure projection from ACP `session/update` notifications to the daemon's
 * runtime-agnostic event stream. Keeping it free of process/transport state is
 * what lets the mapping be unit-tested without spawning `dsh`.
 */

export interface ToolCallInfo {
  /** DSH's programmatic tool name (e.g. `bash`, `write`, `mcp__server__tool`). */
  name: string;
  input: unknown;
}

/** Canonical paboot tool names; clients branch on these for permission cards. */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
};

/** `mcp__<server>__<tool>` already matches paboot's convention. */
export function mapToolName(raw: string): string {
  return TOOL_NAMES[raw] ?? raw;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Text carried by one ACP content block; `null` for non-text payloads. */
function contentText(value: unknown): string | null {
  const content = asRecord(value);
  if (content?.['type'] !== 'text') return null;
  return typeof content['text'] === 'string' ? content['text'] : null;
}

/** Flatten ACP `ToolCallContent[]` (and bare content blocks) into display text. */
function toolResultText(content: unknown, rawOutput: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const record = asRecord(item);
      const text = record?.['type'] === 'content' ? contentText(record['content']) : contentText(item);
      if (text !== null) parts.push(text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (rawOutput !== undefined && rawOutput !== null) {
    return typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
  }
  return '';
}

export interface DeepSeekStreamMapper {
  /** Feed one `session/update` payload. */
  onUpdate(update: unknown): void;
  /** The last observed tool name/input for a call, used to enrich approvals. */
  toolCall(callId: string): ToolCallInfo | undefined;
}

export function createDeepSeekStreamMapper(onEvent: (ev: NormalizedEvent) => void): DeepSeekStreamMapper {
  const calls = new Map<string, ToolCallInfo>();
  const thinkingStarted = new Set<string>();

  return {
    toolCall(callId) {
      return calls.get(callId);
    },

    onUpdate(update) {
      const u = asRecord(update);
      if (!u) return;
      switch (u['sessionUpdate']) {
        case 'agent_message_chunk': {
          const text = contentText(u['content']);
          if (text !== null && text.length > 0) onEvent({ type: 'text_delta', delta: text });
          return;
        }
        case 'agent_thought_chunk': {
          const messageId = readString(u, 'messageId') ?? '';
          if (!thinkingStarted.has(messageId)) {
            thinkingStarted.add(messageId);
            onEvent({ type: 'thinking_start' });
          }
          const text = contentText(u['content']);
          if (text !== null && text.length > 0) onEvent({ type: 'thinking_delta', delta: text });
          return;
        }
        case 'tool_call': {
          const id = readString(u, 'toolCallId');
          if (!id) return;
          const name = readString(u, 'name') ?? readString(u, 'title') ?? readString(u, 'kind') ?? 'tool';
          const input = u['rawInput'];
          calls.set(id, { name, input });
          onEvent({ type: 'tool_use', id, name: mapToolName(name), input });
          return;
        }
        case 'tool_call_update': {
          const id = readString(u, 'toolCallId');
          if (!id) return;
          const status = readString(u, 'status');
          if (status !== 'completed' && status !== 'failed') return;
          onEvent({
            type: 'tool_result',
            toolUseId: id,
            content: toolResultText(u['content'], u['rawOutput']),
            isError: status === 'failed',
          });
          return;
        }
        case 'usage_update': {
          const used = readNumber(u, 'used');
          const size = readNumber(u, 'size');
          if (used === null && size === null) return;
          const cost = asRecord(u['cost']);
          const amount = readNumber(cost, 'amount');
          onEvent({
            type: 'usage',
            usage: null,
            contextTokens: used,
            contextWindow: size,
            ...(amount !== null && cost?.['currency'] === 'USD' ? { costUsd: amount } : {}),
          });
          return;
        }
        default:
          // config_option_update, plan/compaction updates, user echoes: the
          // paboot stream has no surface for them.
          return;
      }
    },
  };
}
