import type { NormalizedEvent } from '../../types/api.js';

/**
 * Codex app-server (protocol v2) → `NormalizedEvent`.
 *
 * This is the Codex counterpart of `../claude/stream.ts`. Both translate a
 * provider wire format into the one union the rest of the daemon speaks; the
 * difference is that Claude hands us a linear line stream while Codex hands us
 * typed notifications, so this file is a dispatcher rather than a parser.
 *
 * Field names come from `codex app-server generate-json-schema` (v2), not from
 * memory. Regenerate after a codex upgrade and re-check this file against the
 * diff — the protocol is marked experimental.
 */

/** One entry of the `ThreadItem` union, as carried by `item/*` notifications. */
export interface CodexItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface CodexStreamMapper {
  beginTurn(): void;
  onNotification(method: string, params: unknown): void;
}

// ---- small readers (the wire is untrusted: every field is `unknown`) ----

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

function readItem(params: Record<string, unknown> | null): CodexItem | null {
  const item = asRecord(params?.['item']);
  const id = readString(item, 'id');
  const type = readString(item, 'type');
  return item && id && type ? ({ ...item, id, type } as CodexItem) : null;
}

/**
 * `CodexErrorInfo` carries the machine-readable reason a turn failed —
 * `usageLimitExceeded`, `rateLimitExceeded`, `contextWindowExceeded`,
 * `sandboxError`, `unauthorized`, … — which is what a client needs to explain a
 * failure in its own words. It is either a bare string or a single-key object
 * (`{httpConnectionFailed: {httpStatusCode}}`); both collapse to a code here.
 */
function readErrorCode(error: Record<string, unknown> | null): string | null {
  const info = error?.['codexErrorInfo'];
  if (typeof info === 'string') return info;
  const wrapped = asRecord(info);
  const keys = wrapped ? Object.keys(wrapped) : [];
  return keys.length === 1 ? keys[0] : null;
}

/** An `error` event body, with the code attached when the provider gave one. */
function readError(error: Record<string, unknown> | null, fallback: string): NormalizedEvent {
  const code = readErrorCode(error);
  return code
    ? { type: 'error', code, message: readString(error, 'message') ?? fallback }
    : { type: 'error', message: readString(error, 'message') ?? fallback };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The reasoning text a completed item carries: `summary` is the human-readable
 * part, `content` the raw one (usually empty — reasoning arrives encrypted).
 * Parts are plain strings today; tolerate `{text}` in case that shape moves.
 * Which of the two is populated depends on the model, so try both.
 */
function reasoningText(item: CodexItem): string {
  const parts = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((part) => (typeof part === 'string' ? part : readString(asRecord(part), 'text') ?? ''))
          .filter(Boolean)
      : [];
  const summary = parts(item['summary']).join('');
  return summary || parts(item['content']).join('');
}

// ---- item → tool shape ----

/**
 * The tool name a `ThreadItem` surfaces as. `null` means the item is not a tool
 * call (messages, reasoning, compaction …) and produces no `tool_use`/`result`.
 *
 * Names are chosen to line up with the Claude names the rest of the daemon
 * already gates on (`tool-grants.ts` keys grants by exact name).
 */
export function codexItemToolName(item: CodexItem): string | null {
  switch (item.type) {
    case 'commandExecution':
      return 'Bash';
    case 'fileChange':
      // Codex collapses create/overwrite/edit into one `fileChange` kind; we
      // surface it as `Edit`. Revisit if the UI ever needs to distinguish.
      return 'Edit';
    case 'mcpToolCall': {
      const server = readString(item, 'server');
      const tool = readString(item, 'tool');
      return server && tool ? `mcp__${server}__${tool}` : 'McpTool';
    }
    case 'dynamicToolCall':
      return readString(item, 'tool') ?? 'Tool';
    case 'collabAgentToolCall':
      return readString(item, 'tool') ?? 'SpawnAgent';
    case 'webSearch':
      return 'WebSearch';
    case 'plan':
      return 'Plan';
    case 'imageGeneration':
      return 'ImageGeneration';
    default:
      return null;
  }
}

export function codexItemToolInput(item: CodexItem): unknown {
  switch (item.type) {
    case 'commandExecution':
      return {
        command: item['command'] ?? null,
        cwd: item['cwd'] ?? null,
        commandActions: item['commandActions'] ?? null,
      };
    case 'fileChange':
      return { changes: item['changes'] ?? null };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item['arguments'] ?? null;
    case 'webSearch':
      return { query: item['query'] ?? null, action: item['action'] ?? null };
    default:
      return null;
  }
}

function codexItemResultText(item: CodexItem): string {
  switch (item.type) {
    case 'commandExecution':
      return stringify(item['aggregatedOutput']) || `(${readString(item, 'status') ?? 'no output'})`;
    case 'fileChange':
      return stringify(item['changes']) || `(${readString(item, 'status') ?? 'applied'})`;
    case 'mcpToolCall':
      return stringify(item['result']) || stringify(item['error']) || '';
    case 'dynamicToolCall':
      return stringify(item['contentItems']) || '';
    case 'webSearch':
      return stringify(item['results']) || '';
    case 'collabAgentToolCall':
      return stringify(item['agentsStates']) || '';
    default:
      return '';
  }
}

/**
 * `CommandExecutionStatus` and `PatchApplyStatus` both include `declined` — a
 * tool the operator refused must not render as a success, since the card then
 * shows the diff/output as if it had been applied.
 */
function codexItemFailed(item: CodexItem): boolean {
  const status = readString(item, 'status');
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
      return status === 'failed' || status === 'declined';
    case 'mcpToolCall':
    case 'imageGeneration':
      return status === 'failed';
    case 'collabAgentToolCall':
      return status === 'failed' || status === 'interrupted';
    case 'dynamicToolCall':
      return item['success'] === false;
    default:
      return false;
  }
}

// ---- the mapper ----

/**
 * Stateful, like the Claude parser: `item/completed` for an assistant message
 * must not re-emit text that already streamed as deltas, and `thinking_start`
 * must fire once per reasoning item rather than per delta.
 */
export function createCodexStreamMapper(
  onEvent: (ev: NormalizedEvent) => void,
  options: { resumed?: boolean } = {},
): CodexStreamMapper {
  type Tokens = { input_tokens: number; output_tokens: number };
  const tokens = (value: unknown): Tokens | null => {
    const record = asRecord(value);
    const input = record?.['inputTokens'];
    const output = record?.['outputTokens'];
    return typeof input === 'number' && Number.isFinite(input) && input >= 0 &&
      typeof output === 'number' && Number.isFinite(output) && output >= 0
      ? { input_tokens: input, output_tokens: output } : null;
  };
  let started = false;
  let previous: Tokens | null = options.resumed ? null : { input_tokens: 0, output_tokens: 0 };
  const usage: Tokens = { input_tokens: 0, output_tokens: 0 };
  let hasUsage = false;

  type Context = { contextTokens: number; contextWindow: number | null };
  /**
   * How full the context window is: the *last* model request's input side
   * (`inputTokens` already includes its cached portion) against the window
   * size. Unlike the accumulated `usage` above this is instantaneous — it goes
   * back down when the thread compacts — so it travels beside the blob.
   */
  const contextOf = (counts: Record<string, unknown> | null): Context | null => {
    const last = asRecord(counts?.['last']);
    const used = last?.['inputTokens'];
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
    const window = counts?.['modelContextWindow'] ?? counts?.['model_context_window'];
    return {
      contextTokens: used,
      contextWindow: typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null,
    };
  };
  let context: Context | null = null;

  const textStreamed = new Set<string>();
  const thinkingStarted = new Set<string>();
  const thinkingStreamed = new Set<string>();

  const startThinking = (itemId: string | null): void => {
    if (itemId === null || thinkingStarted.has(itemId)) return;
    thinkingStarted.add(itemId);
    onEvent({ type: 'thinking_start' });
  };

  return {
    beginTurn() { started = true; },
    onNotification(method: string, params: unknown): void {
      const p = asRecord(params);

      switch (method) {
        case 'thread/started': {
          const thread = asRecord(p?.['thread']);
          onEvent({ type: 'status', label: 'streaming', sessionId: readString(thread, 'id') });
          return;
        }

        case 'turn/started':
          started = true;
          onEvent({ type: 'status', label: 'working' });
          return;

        case 'item/agentMessage/delta': {
          const itemId = readString(p, 'itemId');
          const delta = readString(p, 'delta') ?? '';
          if (itemId) textStreamed.add(itemId);
          if (delta) onEvent({ type: 'text_delta', delta });
          return;
        }

        case 'item/reasoning/summaryPartAdded':
          // No text yet: wait for a delta (or the completed item) so an empty
          // reasoning item does not paint an empty thinking card.
          return;

        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta': {
          // Reasoning can stream without a preceding summaryPartAdded.
          const itemId = readString(p, 'itemId');
          startThinking(itemId);
          if (itemId) thinkingStreamed.add(itemId);
          const delta = readString(p, 'delta') ?? '';
          if (delta) onEvent({ type: 'thinking_delta', delta });
          return;
        }

        case 'item/started': {
          const item = readItem(p);
          if (!item) return;
          // A reasoning item only starts its card once it actually has text.
          const name = codexItemToolName(item);
          if (name) onEvent({ type: 'tool_use', id: item.id, name, input: codexItemToolInput(item) });
          return;
        }

        case 'item/completed': {
          const item = readItem(p);
          if (!item) return;
          if (item.type === 'agentMessage') {
            // Only a message that never streamed deltas is emitted whole.
            if (!textStreamed.has(item.id)) {
              const text = readString(item, 'text') ?? '';
              if (text) onEvent({ type: 'text_delta', delta: text });
            }
            return;
          }
          if (item.type === 'reasoning') {
            // Nothing streamed for this item: the model only hands the summary
            // over at the end. Without this the thinking card stays empty even
            // though the provider did report something.
            if (!thinkingStreamed.has(item.id)) {
              const text = reasoningText(item);
              if (text) {
                startThinking(item.id);
                onEvent({ type: 'thinking_delta', delta: text });
              }
            }
            return;
          }
          const name = codexItemToolName(item);
          if (!name) return;
          onEvent({
            type: 'tool_result',
            toolUseId: item.id,
            content: codexItemResultText(item),
            isError: codexItemFailed(item),
          });
          return;
        }

        case 'error': {
          // The turn's error *notification* (the same failure also lands in
          // `turn/completed`). It is the only place the provider ever names a
          // rate limit, an exhausted quota or a broken sandbox, so it has to
          // reach the client — without it a run that can never start looks like
          // a spinner that never explains itself. Not terminal: `turn/completed`
          // closes the run, and `willRetry` says whether a retry is underneath.
          onEvent(readError(asRecord(p?.['error']), 'codex error'));
          return;
        }

        case 'thread/tokenUsage/updated': {
          const counts = asRecord(p?.['tokenUsage']);
          const total = tokens(counts?.['total']);
          if (!total) return;
          if (!started) {
            // A resume snapshot belongs to older turns, not this run.
            previous = total;
            return;
          }
          if (!previous) {
            // Older servers may not emit a resume snapshot. The first update
            // supplies both this model call and the thread's accumulated total.
            const last = tokens(counts?.['last']);
            if (!last) return;
            previous = {
              input_tokens: Math.max(0, total.input_tokens - last.input_tokens),
              output_tokens: Math.max(0, total.output_tokens - last.output_tokens),
            };
          }
          for (const key of ['input_tokens', 'output_tokens'] as const) {
            usage[key] += Math.max(0, total[key] - previous[key]);
          }
          previous = total;
          hasUsage = true;
          context = contextOf(counts);
          // Mid-run we refresh *only* the context indicator (`usage: null`, so
          // the client keeps the previous usage line). The usage bar is the
          // run's final total, emitted once on `turn/completed` — the timing
          // Claude already has (`result` frame), so both runtimes show it at the
          // same moment instead of Codex ticking up while it works.
          if (context) onEvent({ type: 'usage', usage: null, ...context });
          return;
        }

        case 'turn/completed': {
          const turn = asRecord(p?.['turn']);
          // TurnStatus = completed | interrupted | failed | inProgress
          const status = readString(turn, 'status') ?? 'completed';
          const error = asRecord(turn?.['error']);
          if (error) onEvent(readError(error, 'turn failed'));
          onEvent({
            type: 'usage',
            usage: hasUsage ? { ...usage } : null,
            durationMs: typeof turn?.['durationMs'] === 'number' ? turn['durationMs'] : null,
            stopReason: status,
            // Carry the last known occupancy so the run's final frame is
            // self-contained (history rebuild lands on it deterministically).
            ...(context ?? {}),
          });
          onEvent({ type: 'turn_end', stopReason: status });
          return;
        }

        case 'thread/status/changed': {
          const status = asRecord(p?.['status']);
          onEvent({ type: 'status', label: readString(status, 'type') ?? 'unknown' });
          return;
        }

        default:
          // Everything else (file transfer progress, plan deltas, hook events,
          // realtime audio …) has no `NormalizedEvent` equivalent yet. Dropping
          // is deliberate: see docs/local/codex_adapter_design.md §4.1.
          return;
      }
    },
  };
}

// ---- approvals ----

export interface CodexApproval {
  /** Present only for the structured request_permissions response. */
  requestedPermissions?: Record<string, unknown>;
  toolName: string;
  toolInput: unknown;
}

/**
 * Shape a server→client approval request into the `permission_request` fields.
 * Returns null for requests we do not gate, which the caller answers with an
 * RPC error (see `session.ts`).
 */
export function readCodexApproval(
  method: string, params: unknown, fileChanges: ReadonlyMap<string, unknown> = new Map(),
): CodexApproval | null {
  const p = asRecord(params);
  if (!p) return null;

  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // `kind` splits a shell command from input written to a running terminal.
      // Different tool names so "allow all Bash" cannot silently also permit
      // terminal writes.
      const kind = readString(p, 'kind') ?? 'command';
      return {
        toolName: kind === 'writeStdin' ? 'TerminalInput' : 'Bash',
        toolInput: {
          command: p['command'] ?? null,
          cwd: p['cwd'] ?? null,
          // Already parsed by Codex (read / listFiles / search / unknown) — free
          // material for the client's approval card.
          commandActions: p['commandActions'] ?? null,
          reason: p['reason'] ?? null,
        },
      };
    }

    case 'item/fileChange/requestApproval':
      return {
        toolName: 'Edit',
        toolInput: {
          reason: p['reason'] ?? null, itemId: p['itemId'] ?? null, grantRoot: p['grantRoot'] ?? null,
          changes: fileChanges.get(readString(p, 'itemId') ?? '') ?? null,
        },
      };

    case 'item/permissions/requestApproval':
      return {
        toolName: 'Permissions', toolInput: withExpandedPaths(p),
        requestedPermissions: asRecord(p['permissions']) ?? {},
      };

    default:
      return null;
  }
}

/**
 * The approval card reads `fileSystem.read` / `fileSystem.write`, but Codex is
 * migrating that pair to `entries: [{access, path}]` — the schema already marks
 * the old fields "will be removed in favor of `entries`". A dialog that shows
 * *less* than it grants is the dangerous direction, so expand `entries` into the
 * shapes the client renders. Only the display copy is expanded; the echoed
 * response still carries the raw profile.
 */
function withExpandedPaths(params: Record<string, unknown>): Record<string, unknown> {
  const permissions = asRecord(params['permissions']);
  const fileSystem = asRecord(permissions?.['fileSystem']);
  if (!permissions || !fileSystem) return params;
  if (fileSystem['read'] != null || fileSystem['write'] != null) return params;

  const entries = Array.isArray(fileSystem['entries']) ? fileSystem['entries'] : [];
  if (entries.length === 0) return params;

  const read: string[] = [];
  const write: string[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    const access = readString(entry, 'access');
    const path = asRecord(entry?.['path']);
    const value = readString(path, 'path') ?? readString(path, 'pattern') ?? describeSpecialPath(path);
    // Only a malformed entry with no recognisable path lands here — nothing to
    // show, and nothing was granted under a name the operator could read.
    if (value === null) continue;
    // `deny` entries take access away; they are not grants to display as one.
    if (access === 'read') read.push(value);
    else if (access === 'write') write.push(value);
  }
  return { ...params, permissions: { ...permissions, fileSystem: { ...fileSystem, read, write } } };
}

/**
 * Label the third `FileSystemPath` variant — `{type:'special', value:{kind}}`,
 * where kind is root / minimal / project_roots / tmpdir / slash_tmp / unknown.
 * It is not a string, so the path readers above cannot see it. The labels are
 * Chinese because this is display copy for the permission card (the echoed
 * grant still carries the raw profile); the alternative was showing nothing.
 */
function describeSpecialPath(path: Record<string, unknown> | null): string | null {
  if (path?.['type'] !== 'special') return null;
  const value = asRecord(path['value']);
  const kind = readString(value, 'kind');
  const subpath = readString(value, 'subpath');
  switch (kind) {
    case 'root':
      return '根目录 /';
    case 'minimal':
      return '最小必需路径';
    case 'project_roots':
      return `项目根目录${subpath ? `/${subpath.replace(/^\/+/, '')}` : ''}`;
    case 'tmpdir':
      return '系统临时目录';
    case 'slash_tmp':
      return '/tmp';
    case 'unknown':
      return readString(value, 'path') ?? subpath ?? '未知路径';
    default:
      return kind ? `特殊路径（${kind}）` : '特殊路径';
  }
}

/**
 * The JSON-RPC result body for an approval. `cancel` (deny *and* interrupt the
 * turn) has no equivalent in the product's `allow|deny|allow_all` decision set.
 */
export function codexApprovalResult(
  decision: 'allow' | 'deny' | 'allow_all', approval: CodexApproval,
): { decision: string } | { permissions: Record<string, unknown>; scope: 'turn' | 'session' } {
  if (approval.requestedPermissions !== undefined) {
    // Only echo the requested permission profile, never the whole RPC payload.
    const requested = approval.requestedPermissions;
    const permissions: Record<string, unknown> = {};
    if (decision !== 'deny') {
      for (const key of ['network', 'fileSystem']) {
        if (requested[key] != null) permissions[key] = requested[key];
      }
    }
    // `scope` is how this approval persists, and it is the only lever here:
    // unlike a tool grant, an expanded permission profile has no paboot-side
    // record to revoke. `allow_all` promises "this session" (see the client's
    // 「允许全部」 copy), so it must not be downgraded to a single turn.
    return { permissions, scope: decision === 'allow_all' ? 'session' : 'turn' };
  }
  switch (decision) {
    case 'allow':
      return { decision: 'accept' };
    case 'allow_all':
      // Persistent grants live in paboot so deleting them affects the next ask.
      return { decision: 'accept' };
    case 'deny':
      return { decision: 'decline' };
  }
}
