import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProductPermissionMode } from '../src/types/api';
import {
  NativeToolProvider,
  ToolExecutor,
  ToolRegistry,
  type AgentRunContext,
  type ToolDescriptor,
  type ToolImplementation,
  type ToolResult,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-batch-'));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(root: string, signal?: AbortSignal): AgentRunContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin', role: 'coder' },
    workspace: { id: 'ws-1', name: 'Acme', family: 'dev', root },
    cwd: root,
    extraDirs: [],
    pathPolicy: {
      mode: 'server-strict',
      grants: [{ root, capabilities: ['read', 'write', 'list'] }],
      denyRoots: [],
    },
    permissionMode: 'ask' as ProductPermissionMode,
    signal: signal ?? new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'allowed' }) },
  } as AgentRunContext;
}

function slowTool(
  name: string,
  safe: boolean,
  delayMs: number,
): ToolImplementation {
  const descriptor: ToolDescriptor = {
    name,
    title: name,
    description: name,
    inputSchema: { type: 'object' },
    source: { kind: 'native', id: 'test' },
    sideEffect: 'read',
    concurrencySafe: safe,
    timeoutMs: 5_000,
  };
  return {
    descriptor,
    async call(): Promise<ToolResult> {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: name, isError: false };
    },
  };
}

describe('ToolExecutor.executeBatch', () => {
  it('runs an all-safe batch concurrently and preserves call order', async () => {
    const root = tempDir();
    const agent = makeAgent(root);
    const registry = new ToolRegistry([
      new NativeToolProvider([slowTool('A', true, 80), slowTool('B', true, 80)]),
    ]);
    const executor = new ToolExecutor({ registry });

    const started = Date.now();
    const results = await executor.executeBatch(
      [
        { id: 't1', name: 'A', input: {} },
        { id: 't2', name: 'B', input: {} },
      ],
      agent,
    );

    expect(results.map((result) => result.content)).toEqual(['A', 'B']);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('keeps a batch with any unsafe tool serial', async () => {
    const root = tempDir();
    const agent = makeAgent(root);
    const registry = new ToolRegistry([
      new NativeToolProvider([slowTool('A', true, 60), slowTool('B', false, 60)]),
    ]);
    const executor = new ToolExecutor({ registry });

    const started = Date.now();
    const results = await executor.executeBatch(
      [
        { id: 't1', name: 'A', input: {} },
        { id: 't2', name: 'B', input: {} },
      ],
      agent,
    );

    expect(results.map((result) => result.content)).toEqual(['A', 'B']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('returns one interrupted result per call when the run aborts mid-batch', async () => {
    const root = tempDir();
    const controller = new AbortController();
    const agent = makeAgent(root, controller.signal);
    const registry = new ToolRegistry([
      new NativeToolProvider([slowTool('A', true, 1_000), slowTool('B', true, 1_000)]),
    ]);
    const executor = new ToolExecutor({ registry });
    setTimeout(() => controller.abort(), 30);

    const results = await executor.executeBatch(
      [
        { id: 't1', name: 'A', input: {} },
        { id: 't2', name: 'B', input: {} },
      ],
      agent,
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.interrupted === true)).toBe(true);
  });
});
