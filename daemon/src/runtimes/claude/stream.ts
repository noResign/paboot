import type { NormalizedEvent, QuestionDto } from '../../types/api.js';
import type { StreamParser } from '../types.js';

type EventSink = (ev: NormalizedEvent) => void;

interface BlockState {
  type: string;
  name?: string;
  id?: string;
  input: string;
  inputValue?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isRecord(c) && c.type === 'text' ? String(c.text) : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}

function errorResultMessage(obj: Record<string, unknown>): string {
  if (Array.isArray(obj.errors)) {
    const parts = obj.errors.filter((e): e is string => typeof e === 'string' && e.length > 0);
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof obj.result === 'string' && obj.result.trim()) return obj.result;
  if (typeof obj.subtype === 'string' && obj.subtype) return `Claude run failed: ${obj.subtype}`;
  return 'Claude run failed';
}

/**
 * Incremental parser for Claude Code's `--output-format stream-json
 * --verbose` JSONL stdout. It normalizes the runtime-specific frames into the
 * transport's `NormalizedEvent` union. A direct, trimmed port of the reference
 * project's `claude-stream.ts`, dropping its design-artifact/task-specific
 * logic but keeping the two important behaviors:
 *
 *   - partial tool_use input is accumulated across `input_json_delta` and
 *     emitted once as a complete `tool_use` on `content_block_stop`;
 *   - text/thinking is emitted from `stream_event` deltas when present and
 *     falls back to the final `assistant` wrapper when not, without duplicating.
 */
export function createClaudeStreamParser(onEvent: EventSink): StreamParser {
  let buffer = '';
  const blocks = new Map<string, BlockState>();
  const streamedToolUseIds = new Set<string>();
  const textStreamed = new Set<string>();
  const thinkingStreamed = new Set<string>();
  let currentMessageId: string | null = null;
  let currentMessageStreamedText = false;
  let currentMessageStreamedThinking = false;
  let contextTokens: number | null = null;

  /**
   * Usage announced by `message_start`, held until the owning `assistant` frame
   * arrives — only then is it known to be the main turn rather than a sub-agent's.
   */
  let pendingUsage: unknown = undefined;
  const pendingUsageById = new Map<string, unknown>();

  /**
   * Anthropic splits a request's input into the uncached part (`input_tokens`)
   * plus two cache buckets; the three are disjoint, so their sum is what the
   * next request resends — i.e. how full the context window is. `null` when the
   * frame carries nothing useful, which is not the same as zero.
   */
  function contextTokensOf(usage: unknown): number | null {
    if (!isRecord(usage)) return null;
    const count = (key: string): number => {
      const value = usage[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    };
    const used = count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
    return used > 0 ? used : null;
  }

  /**
   * Report context occupancy as its own frame with `usage: null` — that keeps it
   * out of the per-run usage line on the client (`parseUsage` returns null and
   * the message keeps its previous value) and out of the monotonic total it
   * would otherwise corrupt. Deduped by value: every message carries this
   * figure, and unlike a running total it can go back down (compaction).
   *
   * Claude Code never reports the window size, so there is no denominator.
   */
  function emitContext(usage: unknown): void {
    const used = contextTokensOf(usage);
    if (used === null || used === contextTokens) return;
    contextTokens = used;
    onEvent({ type: 'usage', usage: null, contextTokens: used, contextWindow: null });
  }

  const blockKey = (index: unknown): string => `${currentMessageId ?? 'anon'}:${String(index)}`;

  function emitToolUse(id: unknown, name: unknown, input: unknown): void {
    // AskUserQuestion 是「需要用户回答」的特殊工具，不能当普通工具卡展示；归一化成
    // 独立的 question 事件，让客户端渲染成问答卡。headless 下 Claude 会立即自动拒绝它，
    // 客户端选完答案后作为续接消息发回，而不是回填 tool_result。
    if (String(name) === 'AskUserQuestion') {
      const questions = isRecord(input) && Array.isArray(input.questions)
        ? (input.questions as unknown[])
        : [];
      onEvent({ type: 'question', toolUseId: String(id), questions: questions as QuestionDto[] });
      return;
    }
    onEvent({ type: 'tool_use', id: String(id), name: String(name), input });
  }

  function handleStreamEvent(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case 'message_start': {
        const message = isRecord(ev.message) ? ev.message : null;
        currentMessageId = message && typeof message.id === 'string' ? message.id : null;
        currentMessageStreamedText = false;
        currentMessageStreamedThinking = false;
        // Buffer *this request's* usage. It is the most dependable source — some
        // CLI builds omit it from the `assistant` frame that follows — but this
        // frame carries no parent id, so which thread it belongs to (main turn,
        // or a sub-agent with its own context window) is only knowable later.
        if (message) {
          pendingUsage = message.usage;
          if (typeof message.id === 'string') pendingUsageById.set(message.id, message.usage);
        }
        if (typeof ev.ttft_ms === 'number') {
          onEvent({ type: 'status', label: 'streaming', ttftMs: ev.ttft_ms });
        }
        return;
      }
      case 'content_block_start': {
        if (!isRecord(ev.content_block)) return;
        const block = ev.content_block;
        blocks.set(blockKey(ev.index), {
          type: String(block.type),
          name: typeof block.name === 'string' ? block.name : undefined,
          id: typeof block.id === 'string' ? block.id : undefined,
          input: '',
          inputValue: 'input' in block ? block.input : undefined,
        });
        if (block.type === 'thinking') onEvent({ type: 'thinking_start' });
        return;
      }
      case 'content_block_delta': {
        if (!isRecord(ev.delta)) return;
        const state = blocks.get(blockKey(ev.index));
        const delta = ev.delta;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
          if (currentMessageId) textStreamed.add(currentMessageId);
          currentMessageStreamedText = true;
          onEvent({ type: 'text_delta', delta: delta.text });
          return;
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
          if (currentMessageId) thinkingStreamed.add(currentMessageId);
          currentMessageStreamedThinking = true;
          onEvent({ type: 'thinking_delta', delta: delta.thinking });
          return;
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (state && state.type === 'tool_use') state.input += delta.partial_json;
        }
        return;
      }
      case 'content_block_stop': {
        const key = blockKey(ev.index);
        const state = blocks.get(key);
        if (state && state.type === 'tool_use' && typeof state.id === 'string') {
          // Claude 的 --include-partial-messages 输出里，assistant 完整消息可能
          // 先于 content_block_stop 到达；若已通过 assistant 分支 emit 过则跳过。
          if (streamedToolUseIds.has(state.id)) {
            blocks.delete(key);
            return;
          }
          if (state.input.trim()) {
            try {
              emitToolUse(state.id, state.name, JSON.parse(state.input));
              streamedToolUseIds.add(state.id);
            } catch {
              // Malformed streamed JSON; fall through to the assistant wrapper.
            }
          } else if (state.inputValue !== undefined) {
            emitToolUse(state.id, state.name, state.inputValue);
            streamedToolUseIds.add(state.id);
          }
        }
        blocks.delete(key);
        return;
      }
      default:
        return;
    }
  }

  function handleObject(obj: unknown): void {
    if (!isRecord(obj)) return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      onEvent({
        type: 'status',
        label: 'initializing',
        model: typeof obj.model === 'string' ? obj.model : null,
        sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
      });
      return;
    }

    if (obj.type === 'system' && obj.subtype === 'status') {
      onEvent({ type: 'status', label: typeof obj.status === 'string' ? obj.status : 'working' });
      return;
    }

    if (obj.type === 'stream_event' && isRecord(obj.event)) {
      handleStreamEvent(obj.event);
      return;
    }

    if (obj.type === 'assistant' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      const explicitMsgId = typeof obj.message.id === 'string' ? obj.message.id : null;
      const textMsgId = explicitMsgId ?? (currentMessageStreamedText ? currentMessageId : null);
      const thinkingMsgId = explicitMsgId ?? (currentMessageStreamedThinking ? currentMessageId : null);
      if (explicitMsgId) currentMessageId = explicitMsgId;
      const textAlready = textMsgId ? textStreamed.has(textMsgId) : false;
      const thinkingAlready = thinkingMsgId ? thinkingStreamed.has(thinkingMsgId) : false;
      const stopReason = typeof obj.message.stop_reason === 'string' ? obj.message.stop_reason : null;

      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && streamedToolUseIds.has(block.id)) continue;
          emitToolUse(block.id, block.name, block.input ?? null);
          // 记录已 emit，避免 content_block_stop 稍后到达时重复 emit
          if (typeof block.id === 'string') streamedToolUseIds.add(block.id);
        } else if (!textAlready && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          onEvent({ type: 'text_delta', delta: block.text });
        } else if (
          !thinkingAlready &&
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking !== ''
        ) {
          onEvent({ type: 'thinking_delta', delta: block.thinking });
        }
      }

      // Sub-agent frames have their own context window, so only the main turn's
      // occupancy describes this session. (Checked here rather than in
      // `message_start`: stream_event frames carry no parent id — so the usage was
      // buffered there and is adopted here, now that the thread is known.)
      if (obj.parent_tool_use_id == null) {
        const buffered = (explicitMsgId ? pendingUsageById.get(explicitMsgId) : undefined) ?? pendingUsage;
        // Prefer what this frame carries; fall back to what its `message_start`
        // announced, since some builds leave `usage` off the assistant frame.
        emitContext(contextTokensOf(obj.message.usage) !== null ? obj.message.usage : buffered);
      }

      // Only the MAIN turn's boundary counts. Sub-agent frames carry a
      // non-null parent_tool_use_id and must not close the run early.
      if (stopReason && obj.parent_tool_use_id == null) {
        onEvent({ type: 'turn_end', stopReason });
      }
      currentMessageStreamedText = false;
      currentMessageStreamedThinking = false;
      return;
    }

    if (obj.type === 'user' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (!isRecord(block) || block.type !== 'tool_result') continue;
        onEvent({
          type: 'tool_result',
          toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          content: stringifyToolResult(block.content),
          isError: block.is_error === true,
        });
      }
      return;
    }

    if (obj.type === 'result') {
      const isError = obj.is_error === true;
      // ⚠️ Do **not** derive context occupancy from `obj.usage` here. It is the
      // *query's aggregate* — it sits next to `num_turns` / `modelUsage` and sums
      // every internal turn, and each tool call is another request. On a long
      // agentic run that reaches millions, which is how a "context" readout of
      // 10M+ happened. Occupancy is per-request and comes from `message_start` /
      // the `assistant` frame; this frame only *repeats* whatever they reported.
      const stopReason =
        (typeof obj.stop_reason === 'string' && obj.stop_reason) ||
        (typeof obj.terminal_reason === 'string' && obj.terminal_reason) ||
        null;
      onEvent({
        type: 'usage',
        usage: obj.usage ?? null,
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
        stopReason,
        ...(isError ? { isError: true } : {}),
        // Self-contained last frame: history rebuild lands on this one.
        ...(contextTokens !== null ? { contextTokens, contextWindow: null } : {}),
      });
      // `result` is the authoritative "this turn actually finished" signal (the
      // `assistant` frame's stop_reason is null in recent Claude versions).
      // Emit turn_end so the engine closes stdin and the child exits; otherwise
      // the run hangs with stdin open and the client never sees a terminal event.
      if (stopReason && stopReason !== 'tool_use') {
        onEvent({ type: 'turn_end', stopReason });
      }
      if (isError) {
        onEvent({
          type: 'error',
          code: typeof obj.subtype === 'string' && obj.subtype ? obj.subtype : 'result_error',
          message: errorResultMessage(obj),
          terminal: true,
        });
      }
      return;
    }
  }

  function feed(chunk: string): void {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        onEvent({ type: 'error', code: 'parse_error', message: 'unparseable line from runtime' });
        continue;
      }
      handleObject(obj);
    }
  }

  function flush(): void {
    const rem = buffer.trim();
    buffer = '';
    if (!rem) return;
    try {
      handleObject(JSON.parse(rem));
    } catch {
      onEvent({ type: 'error', code: 'parse_error', message: 'unparseable trailing data from runtime' });
    }
  }

  return { feed, flush };
}
