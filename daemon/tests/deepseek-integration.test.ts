import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '../src/types/api';
import { PermissionManager } from '../src/permissions';

const rpc = vi.hoisted(() => ({
  notify: null as ((method: string, params: unknown) => void) | null,
  server: null as ((method: string, params: unknown, id?: number) => unknown) | null,
  spawnOptions: [] as Array<{ bin: string; cwd: string; env: NodeJS.ProcessEnv }>,
  requests: [] as Array<{ method: string; params: unknown; timeout: number | undefined }>,
  request: vi.fn(),
  notifyMessage: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../src/runtimes/deepseek/rpc', () => ({
  initializeDeepSeekAcp: vi.fn(async () => {}),
  spawnDeepSeekAcp: vi.fn((options: { bin: string; cwd: string; env: NodeJS.ProcessEnv }) => {
    rpc.spawnOptions.push(options);
    return {
      request: rpc.request,
      notify: (method: string, params: unknown) => {
        rpc.notifyMessage(method, params);
        rpc.requests.push({ method, params, timeout: undefined });
      },
      close: rpc.close,
      onNotification: (handler: (method: string, params: unknown) => void) => {
        rpc.notify = handler;
      },
      onServerRequest: (handler: (method: string, params: unknown, id?: number) => unknown) => {
        rpc.server = handler;
      },
      onStderr: vi.fn(),
      onExit: vi.fn(),
    };
  }),
}));

import { startDeepSeekRun } from '../src/runtimes/deepseek/session';

const toolServer = {
  name: 'paboot_tasks',
  command: '/usr/bin/node',
  args: ['/opt/paboot/mcp-server.js'],
  env: { PABOOT_DAEMON_URL: 'http://127.0.0.1:4780', PABOOT_TOKEN: 'secret', PABOOT_RUN_ID: 'run-1' },
};

function setup(permissionDecision: 'allow' | 'deny' = 'allow') {
  const permissions = new PermissionManager(5_000);
  const events: NormalizedEvent[] = [];
  const notified: NormalizedEvent[] = [];
  const notifier = {
    emit: (_runId: string, event: NormalizedEvent): boolean => {
      notified.push(event);
      if (event.type === 'permission_request') {
        queueMicrotask(() => permissions.decide(event.permissionId, permissionDecision));
      }
      return true;
    },
  };
  const db = { hasPermissionGrant: vi.fn(() => false) };
  return { permissions, events, notified, notifier, db };
}

beforeEach(() => {
  rpc.spawnOptions.length = 0;
  rpc.requests.length = 0;
  rpc.notify = null;
  rpc.server = null;
  rpc.request.mockReset();
  rpc.notifyMessage.mockReset();
  rpc.close.mockReset().mockResolvedValue(undefined);
});

describe('startDeepSeekRun', () => {
  it('creates an ACP session, applies model knobs, and projects updates', async () => {
    rpc.request.mockImplementation(async (method: string, params: unknown) => {
      rpc.requests.push({ method, params, timeout: 0 });
      if (method === 'session/new') return { sessionId: 'acp-1', configOptions: [] };
      if (method === 'session/prompt') {
        rpc.notify?.('session/update', {
          sessionId: 'acp-1',
          update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } },
        });
        rpc.notify?.('session/update', {
          sessionId: 'acp-1',
          update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', rawInput: { command: 'ls' } },
        });
        rpc.notify?.('session/update', {
          sessionId: 'acp-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
          },
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const { permissions, events, notifier, db } = setup();
    const onNativeSessionId = vi.fn();
    const run = startDeepSeekRun({
      id: 'run-1',
      sessionId: 'session-1',
      prompt: 'list files',
      cwd: '/workspace',
      model: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']),
      modelParameters: { reasoningEffort: 'high' },
      bin: 'dsh',
      permissionMode: 'ask',
      toolServers: [toolServer],
      deps: { permissions, notifier, db },
      onEvent: (event) => events.push(event),
      onNativeSessionId,
    });

    await expect(run.promise).resolves.toEqual({ status: 'succeeded', exitCode: 0, error: null });

    expect(onNativeSessionId).toHaveBeenCalledWith('acp-1');
    expect(events).toEqual([
      { type: 'text_delta', delta: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
      { type: 'turn_end', stopReason: 'end_turn' },
    ]);

    expect(rpc.spawnOptions[0]).toMatchObject({
      bin: 'dsh',
      cwd: '/workspace',
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    expect(rpc.requests.find((entry) => entry.method === 'session/new')?.params).toMatchObject({
      cwd: '/workspace',
      mcpServers: [
        {
          name: 'paboot_tasks',
          command: '/usr/bin/node',
          args: ['/opt/paboot/mcp-server.js'],
          env: [
            { name: 'PABOOT_DAEMON_URL', value: 'http://127.0.0.1:4780' },
            { name: 'PABOOT_TOKEN', value: 'secret' },
            { name: 'PABOOT_RUN_ID', value: 'run-1' },
          ],
        },
      ],
    });
    expect(rpc.requests.filter((entry) => entry.method === 'session/set_config_option')).toEqual([
      expect.objectContaining({
        params: { sessionId: 'acp-1', configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]' },
      }),
      expect.objectContaining({
        params: { sessionId: 'acp-1', configId: 'reasoning_effort', value: 'high' },
      }),
    ]);
    // The prompt has no RPC deadline; the run's idle watchdog is the liveness bound.
    expect(rpc.requests.find((entry) => entry.method === 'session/prompt')?.timeout).toBe(0);
  });

  it('resumes a persisted ACP session and forwards a permission request', async () => {
    let permissionResult: unknown;
    rpc.request.mockImplementation(async (method: string, params: unknown) => {
      rpc.requests.push({ method, params, timeout: 0 });
      if (method === 'session/resume') return { configOptions: [] };
      if (method === 'session/prompt') {
        rpc.notify?.('session/update', {
          sessionId: 'acp-old',
          update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', rawInput: { command: 'git status' } },
        });
        permissionResult = await rpc.server?.('session/request_permission', {
          sessionId: 'acp-old',
          toolCall: { toolCallId: 't1' },
          options: [
            { optionId: 'allow-once', kind: 'allow_once' },
            { optionId: 'reject-once', kind: 'reject_once' },
          ],
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const { permissions, events, notified, notifier, db } = setup('allow');
    const onNativeSessionId = vi.fn();
    const run = startDeepSeekRun({
      id: 'run-2',
      sessionId: 'session-1',
      prompt: 'status?',
      cwd: '/workspace',
      resumeSessionId: 'acp-old',
      bin: 'dsh',
      permissionMode: 'ask',
      deps: { permissions, notifier, db },
      onEvent: (event) => events.push(event),
      onNativeSessionId,
    });

    await expect(run.promise).resolves.toMatchObject({ status: 'succeeded' });
    expect(onNativeSessionId).not.toHaveBeenCalled();
    expect(rpc.requests.some((entry) => entry.method === 'session/new')).toBe(false);
    expect(rpc.requests.find((entry) => entry.method === 'session/prompt')?.params).toMatchObject({
      sessionId: 'acp-old',
    });
    expect(permissionResult).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(notified).toContainEqual({
      type: 'permission_request',
      permissionId: expect.any(String),
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      status: 'pending',
    });
    expect(events.some((event) => event.type === 'turn_end')).toBe(true);
  });

  it('auto-approves edits under acceptEdits without asking the operator', async () => {
    let permissionResult: unknown;
    rpc.request.mockImplementation(async (method: string) => {
      if (method === 'session/new') return { sessionId: 'acp-1' };
      if (method === 'session/prompt') {
        rpc.notify?.('session/update', {
          sessionId: 'acp-1',
          update: { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'edit', rawInput: { file_path: '/a.ts' } },
        });
        permissionResult = await rpc.server?.('session/request_permission', {
          sessionId: 'acp-1',
          toolCall: { toolCallId: 'e1' },
          options: [
            { optionId: 'allow-once', kind: 'allow_once' },
            { optionId: 'reject-once', kind: 'reject_once' },
          ],
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const { permissions, events, notified, notifier, db } = setup('deny');
    const run = startDeepSeekRun({
      id: 'run-3',
      sessionId: 'session-1',
      prompt: 'edit',
      cwd: '/workspace',
      bin: 'dsh',
      permissionMode: 'acceptEdits',
      deps: { permissions, notifier, db },
      onEvent: (event) => events.push(event),
    });

    await expect(run.promise).resolves.toMatchObject({ status: 'succeeded' });
    expect(permissionResult).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(notified.some((event) => event.type === 'permission_request')).toBe(false);
    expect(rpc.spawnOptions[0]?.env.DSH_PERMISSION_MODE).toBe('workspace-write');
  });
});
