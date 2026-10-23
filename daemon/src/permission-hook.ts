#!/usr/bin/env node
/**
 * PreToolUse hook script invoked by Claude Code before each tool call. It
 * relays the pending tool to the daemon, blocks until the remote operator
 * decides, then prints the hook response that allows or denies the call.
 *
 * Current Claude Code hook response shape:
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":"..."}}
 *
 * The daemon passes itself in via env (set by the engine at spawn time):
 * PABOOT_DAEMON_URL, PABOOT_TOKEN, PABOOT_RUN_ID.
 *
 * Only the tools the chat route put in the matcher reach this script — today
 * Bash, the write/edit tools, WebSearch/WebFetch, and MCP (reads are not gated).
 * So every call here is a genuine ask: it goes straight to the daemon, no local
 * shortcuts.
 */

const POLL_INTERVAL_MS = 250;
// daemon 决策窗口由 engine spawn 时下发；轮询兜底超时在此之上加缓冲，保证 hook 一定
// 等到 daemon 先定论（timed_out），只有 daemon 不可达时才走兜底 deny。
const DAEMON_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PABOOT_PERMISSION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();
const POLL_TIMEOUT_MS = DAEMON_TIMEOUT_MS + 15_000;

async function readAllStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function emit(decision: 'allow' | 'deny', reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function requestDecision(
  toolName: string,
  toolInput: unknown,
): Promise<{ decision: 'allow' | 'deny'; reason: string }> {
  const daemonUrl = process.env.PABOOT_DAEMON_URL ?? '';
  const token = process.env.PABOOT_TOKEN ?? '';
  const runId = process.env.PABOOT_RUN_ID ?? '';
  if (!daemonUrl || !token || !runId) {
    return { decision: 'deny', reason: 'paboot permission hook not configured (missing env)' };
  }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  let id: string;
  try {
    const res = await fetch(`${daemonUrl}/api/internal/permissions/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ runId, toolName, toolInput }),
    });
    if (!res.ok) {
      return { decision: 'deny', reason: `daemon rejected permission request (HTTP ${res.status})` };
    }
    id = ((await res.json()) as { id?: string }).id ?? '';
  } catch (err) {
    return { decision: 'deny', reason: `failed to reach daemon: ${String(err)}` };
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${daemonUrl}/api/internal/permissions/${id}/status`, { headers });
      if (res.ok) {
        const s = (await res.json()) as { status?: string; decisionReason?: string | null };
        if (s.status === 'allowed') return { decision: 'allow', reason: s.decisionReason ?? 'allowed' };
        if (s.status === 'denied' || s.status === 'timed_out') {
          return { decision: 'deny', reason: s.decisionReason ?? 'denied' };
        }
      }
    } catch {
      // transient — keep polling until the deadline
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { decision: 'deny', reason: 'timed out waiting for approval' };
}

async function main(): Promise<void> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(await readAllStdin()) as Record<string, unknown>;
  } catch {
    emit('deny', 'unparseable hook input');
    return;
  }
  const toolName =
    typeof input.tool_name === 'string'
      ? input.tool_name
      : typeof input.toolName === 'string'
        ? input.toolName
        : 'unknown';
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};

  const result = await requestDecision(toolName, toolInput);
  emit(result.decision, result.reason);
}

main().catch((err) => {
  process.stderr.write(`paboot-permission-hook: ${err instanceof Error ? err.message : String(err)}\n`);
  emit('deny', 'hook error');
});
