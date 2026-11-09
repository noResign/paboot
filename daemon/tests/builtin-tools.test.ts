import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProductPermissionMode } from '../src/types/api';
import {
  createReadTool,
  defaultToolApprovalPolicy,
  NativeToolProvider,
  PathPolicyError,
  resolvePathAccess,
  ToolExecutor,
  ToolRegistry,
  type AgentEvent,
  type AgentRunContext,
  type ToolCallRequest,
  type ToolDescriptor,
  type ToolImplementation,
  type ToolPermissionDecision,
  type ToolResult,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'paboot-tools-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(options: {
  root: string;
  permissionMode?: ProductPermissionMode;
  policyMode?: 'local' | 'server-strict' | 'bypass';
  broker?: (name: string) => Promise<ToolPermissionDecision>;
  events?: AgentEvent[];
}): AgentRunContext {
  const events = options.events ?? [];
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin', role: 'coder' },
    workspace: { id: 'ws-1', name: 'Acme', family: 'dev', root: options.root },
    cwd: options.root,
    extraDirs: [],
    pathPolicy: {
      mode: options.policyMode ?? 'server-strict',
      grants: [{ root: options.root, capabilities: ['read', 'write', 'list'] }],
      denyRoots: [],
    },
    permissionMode: options.permissionMode ?? 'ask',
    signal: new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: {
      emit: (event) => {
        events.push(event);
      },
    },
    permissionBroker: {
      request: async ({ toolName }) =>
        options.broker ? options.broker(toolName) : { status: 'denied' },
    },
  };
}

function tool(name: string, sideEffect: ToolDescriptor['sideEffect'], result: ToolResult | (() => Promise<ToolResult> | ToolResult)): ToolImplementation {
  return {
    descriptor: {
      name,
      title: name,
      description: `${name} tool`,
      inputSchema: { type: 'object' },
      source: { kind: 'native', id: 'test' },
      sideEffect,
      concurrencySafe: true,
      timeoutMs: 100,
    },
    async call() {
      return typeof result === 'function' ? await result() : result;
    },
  };
}

describe('PathPolicy', () => {
  it('allows granted reads, rejects outside paths, and enforces capabilities', () => {
    const root = tempDir();
    const outside = tempDir();
    const insideFile = path.join(root, 'a.txt');
    const outsideFile = path.join(outside, 'b.txt');
    fs.writeFileSync(insideFile, 'a');
    fs.writeFileSync(outsideFile, 'b');
    const agent = makeAgent({ root });

    expect(
      resolvePathAccess({
        policy: agent.pathPolicy,
        cwd: root,
        requestedPath: 'a.txt',
        capability: 'read',
      }).path,
    ).toBe(fs.realpathSync(insideFile));

    expect(() =>
      resolvePathAccess({
        policy: agent.pathPolicy,
        cwd: root,
        requestedPath: outsideFile,
        capability: 'read',
      }),
    ).toThrow(PathPolicyError);

    const readOnlyPolicy = {
      ...agent.pathPolicy,
      grants: [{ root, capabilities: ['read'] as const }],
    };
    expect(() =>
      resolvePathAccess({
        policy: readOnlyPolicy,
        cwd: root,
        requestedPath: 'new.txt',
        capability: 'write',
      }),
    ).toThrow(/capability/);
  });

  it('local profile reads outside the workspace but keeps writes gated', () => {
    const root = tempDir();
    const outside = tempDir();
    const outsideFile = path.join(outside, 'b.txt');
    fs.writeFileSync(outsideFile, 'b');
    const agent = makeAgent({ root, policyMode: 'local' });

    expect(
      resolvePathAccess({
        policy: agent.pathPolicy,
        cwd: root,
        requestedPath: outsideFile,
        capability: 'read',
      }).path,
    ).toBe(fs.realpathSync(outsideFile));

    expect(() =>
      resolvePathAccess({
        policy: agent.pathPolicy,
        cwd: root,
        requestedPath: outsideFile,
        capability: 'write',
      }),
    ).toThrow(/outside allowed roots/);
  });

  it('rejects symlink escapes but bypass permits them', () => {
    const root = tempDir();
    const outside = tempDir();
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(root, 'link.txt'));
    const strict = makeAgent({ root });

    expect(() =>
      resolvePathAccess({
        policy: strict.pathPolicy,
        cwd: root,
        requestedPath: 'link.txt',
        capability: 'read',
      }),
    ).toThrow(/outside allowed roots/);

    const bypass = makeAgent({ root, policyMode: 'bypass' });
    expect(
      resolvePathAccess({
        policy: bypass.pathPolicy,
        cwd: root,
        requestedPath: 'link.txt',
        capability: 'read',
      }).path,
    ).toBe(fs.realpathSync(outsideFile));
  });

  it('honours deny roots even when a broader grant exists', () => {
    const root = tempDir();
    const denied = path.join(root, 'private');
    fs.mkdirSync(denied);
    const agent = makeAgent({ root });
    agent.pathPolicy.denyRoots = [denied];

    expect(() =>
      resolvePathAccess({
        policy: agent.pathPolicy,
        cwd: root,
        requestedPath: 'private/a.txt',
        capability: 'read',
      }),
    ).toThrow(/denied/);
  });
});

describe('Read tool', () => {
  it('returns numbered lines with offset and limit', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'one\ntwo\nthree\nfour\n');
    const agent = makeAgent({ root });
    const result = await createReadTool().call(
      { file_path: 'notes.txt', offset: 2, limit: 2 },
      { agent, signal: agent.signal, callId: 'call-1' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe('     2→two\n     3→three');
    expect(result.meta).toMatchObject({ lines: 4, offset: 2, limit: 2, truncated: false });
  });

  it('rejects directories, binary files, missing files and outside paths', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'bin'), Buffer.from([0, 1, 2]));
    const agent = makeAgent({ root });
    const read = createReadTool();
    const call = (file_path: string) =>
      read.call({ file_path }, { agent, signal: agent.signal, callId: 'call-1' });

    await expect(call('dir')).rejects.toThrow(/not a file/);
    await expect(call('bin')).rejects.toThrow(/binary/);
    await expect(call('missing.txt')).rejects.toThrow(/file not found/);
    await expect(call('/etc/passwd')).rejects.toThrow(/outside allowed roots/);
  });

  it('validates arguments and offset range', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'one.txt'), 'only\n');
    const agent = makeAgent({ root });
    const call = (input: unknown) =>
      createReadTool().call(input, { agent, signal: agent.signal, callId: 'call-1' });

    await expect(call({})).rejects.toThrow(/file_path/);
    await expect(call({ file_path: 'one.txt', offset: 0 })).rejects.toThrow(/positive integer/);
    await expect(call({ file_path: 'one.txt', offset: 2 })).rejects.toThrow(/beyond end/);
  });

  it('can read outside the workspace under bypass path policy', async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside\n');
    const agent = makeAgent({ root, policyMode: 'bypass', permissionMode: 'bypass' });
    const result = await createReadTool().call(
      { file_path: path.join(outside, 'outside.txt') },
      { agent, signal: agent.signal, callId: 'call-1' },
    );
    expect(result.content).toContain('outside');
  });

  it('stops at the token output budget', async () => {
    const root = tempDir();
    fs.writeFileSync(
      path.join(root, 'long.txt'),
      Array.from({ length: 50 }, (_, index) => `line-${index}-${'x'.repeat(40)}`).join('\n'),
    );
    const agent = makeAgent({ root });
    const result = await createReadTool({
      maxOutputTokens: 60,
      measure: (text) => text.length,
    }).call({ file_path: 'long.txt' }, { agent, signal: agent.signal, callId: 'call-1' });

    expect(result.meta).toMatchObject({ truncated: true });
    expect(result.content).toContain('[output truncated at 60 tokens]');
  });
});

describe('ToolRegistry and executor', () => {
  it('routes calls and emits paired tool events', async () => {
    const root = tempDir();
    const events: AgentEvent[] = [];
    const agent = makeAgent({ root, permissionMode: 'ask', events });
    const registry = new ToolRegistry([
      new NativeToolProvider([
        tool('Echo', 'read', { content: 'hello', isError: false }),
      ]),
    ]);
    const executor = new ToolExecutor({ registry });
    const call: ToolCallRequest = { id: 't1', name: 'Echo', input: { value: 1 } };

    const result = await executor.execute(call, agent);
    expect(result).toEqual({ content: 'hello', isError: false });
    expect(events).toEqual([
      { type: 'tool_use', id: 't1', name: 'Echo', input: { value: 1 } },
      { type: 'tool_result', toolUseId: 't1', content: 'hello', isError: false },
    ]);
  });

  it('truncates oversized tool results before emitting and returning them', async () => {
    const root = tempDir();
    const events: AgentEvent[] = [];
    const agent = makeAgent({ root, events });
    const registry = new ToolRegistry([
      new NativeToolProvider([
        tool('Echo', 'read', { content: `HEAD${'x'.repeat(1_000)}TAIL`, isError: false }),
      ]),
    ]);
    const executor = new ToolExecutor({
      registry,
      maxResultTokens: 200,
      measure: (text) => text.length,
    });

    const result = await executor.execute({ id: 't1', name: 'Echo', input: {} }, agent);

    expect(result.content.length).toBeLessThanOrEqual(200);
    expect(result.content).toContain('HEAD');
    expect(result.content).toContain('TAIL');
    expect(result.content).toContain('tool result truncated');
    const emitted = events.find((event) => event.type === 'tool_result');
    expect(emitted).toMatchObject({ content: result.content });
  });

  it('asks before mutations and does not execute when denied', async () => {
    const root = tempDir();
    const execute = vi.fn(() => ({ content: 'wrote', isError: false }));
    const broker = vi.fn(async (): Promise<ToolPermissionDecision> => ({ status: 'denied' }));
    const agent = makeAgent({ root, permissionMode: 'ask', broker });
    const registry = new ToolRegistry([
      new NativeToolProvider([
        tool('Write', 'write', execute),
      ]),
    ]);
    const result = await new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Write', input: { file_path: 'a' } },
      agent,
    );

    expect(broker).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, content: /not approved/ });
  });

  it('runs mutations without approval under bypass', async () => {
    const root = tempDir();
    const broker = vi.fn(async (): Promise<ToolPermissionDecision> => ({ status: 'denied' }));
    const execute = vi.fn(() => ({ content: 'wrote', isError: false }));
    const agent = makeAgent({ root, permissionMode: 'bypass', broker, policyMode: 'bypass' });
    const registry = new ToolRegistry([
      new NativeToolProvider([tool('Write', 'write', execute)]),
    ]);
    const result = await new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Write', input: {} },
      agent,
    );

    expect(broker).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.content).toBe('wrote');
  });

  it('converts thrown tool errors into tool results', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const registry = new ToolRegistry([
      new NativeToolProvider([
        tool('Broken', 'read', () => {
          throw new Error('boom sk-secret-12345678');
        }),
      ]),
    ]);
    const result = await new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Broken', input: {} },
      agent,
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('boom');
    expect(result.content).not.toContain('sk-secret');
  });

  it('times out a slow tool without killing the executor', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const slow: ToolImplementation = {
      ...tool('Slow', 'read', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { content: 'late', isError: false };
      }),
      descriptor: { ...tool('Slow', 'read', { content: 'x', isError: false }).descriptor, timeoutMs: 5 },
    };
    const registry = new ToolRegistry([new NativeToolProvider([slow])]);
    const result = await new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Slow', input: {} },
      agent,
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('timed out');
  });

  it('returns interrupted result when the run is cancelled during a tool', async () => {
    const root = tempDir();
    const controller = new AbortController();
    const agent = makeAgent({ root });
    agent.signal = controller.signal;
    const slow: ToolImplementation = {
      ...tool('Slow', 'read', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { content: 'late', isError: false };
      }),
      descriptor: { ...tool('Slow', 'read', { content: 'x', isError: false }).descriptor, timeoutMs: 500 },
    };
    const registry = new ToolRegistry([new NativeToolProvider([slow])]);
    const pending = new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Slow', input: {} },
      agent,
    );
    setTimeout(() => controller.abort(), 5);
    await expect(pending).resolves.toMatchObject({ isError: true, interrupted: true });
  });

  it('rejects duplicate tool names across providers', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const registry = new ToolRegistry([
      new NativeToolProvider([tool('Same', 'read', { content: 'a', isError: false })]),
      new NativeToolProvider([tool('Same', 'read', { content: 'b', isError: false })]),
    ]);
    await expect(registry.list({ agent, signal: agent.signal })).rejects.toThrow(/duplicate/);
  });
});

describe('default approval policy', () => {
  it('allows reads and asks for mutations, except bypass/acceptEdits cases', () => {
    const descriptor = (sideEffect: ToolDescriptor['sideEffect']): ToolDescriptor => ({
      name: 'x',
      title: 'x',
      description: 'x',
      inputSchema: {},
      source: { kind: 'native', id: 'builtin' },
      sideEffect,
      concurrencySafe: true,
    });
    const root = tempDir();
    const ask = makeAgent({ root, permissionMode: 'ask' });
    const accept = makeAgent({ root, permissionMode: 'acceptEdits' });
    const bypass = makeAgent({ root, permissionMode: 'bypass', policyMode: 'bypass' });

    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('read'), input: {}, agent: ask })).toBe('allow');
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('write'), input: {}, agent: ask })).toBe('ask');
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('write'), input: {}, agent: accept })).toBe('allow');
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('execute'), input: {}, agent: accept })).toBe('ask');
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('execute'), input: {}, agent: bypass })).toBe('allow');
    // MCP tools (capability / memory) always ask outside bypass; the MCP server
    // itself must not gate again for the builtin runtime.
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('mcp'), input: {}, agent: ask })).toBe('ask');
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('mcp'), input: {}, agent: accept })).toBe('ask');
    expect(defaultToolApprovalPolicy.decide({ descriptor: descriptor('mcp'), input: {}, agent: bypass })).toBe('allow');
  });
});
