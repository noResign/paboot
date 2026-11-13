import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProductPermissionMode } from '../src/types/api';
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  NativeToolProvider,
  ReadFilesTracker,
  ToolExecutor,
  ToolRegistry,
  type AgentEvent,
  type AgentRunContext,
  type NativeMessage,
  type ToolCallContext,
  type ToolPermissionDecision,
  type TranscriptContentBlock,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'paboot-files-'): string {
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
    eventSink: { emit: (event) => options.events?.push(event) },
    permissionBroker: {
      request: async ({ toolName }) =>
        options.broker ? options.broker(toolName) : { status: 'denied' },
    },
  } as AgentRunContext;
}

function callContext(agent: AgentRunContext): ToolCallContext {
  return { agent, signal: agent.signal, callId: 'call-1' };
}

function nativeMessage(
  id: number,
  role: 'assistant' | 'tool',
  blocks: TranscriptContentBlock[],
): NativeMessage {
  return {
    id,
    threadId: 'thread-1',
    seq: id,
    role,
    blocks,
    source: { kind: 'model', provider: 'fake', model: 'fake-1' },
    runId: 'run-1',
    step: 1,
    provider: 'fake',
    model: 'fake-1',
    usage: null,
    formatVersion: 1,
    createdAt: 0,
  };
}

describe('Write tool', () => {
  it('creates parent directories and writes content', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const tool = createWriteTool();
    const target = path.join(root, 'nested', 'dir', 'file.txt');

    const result = await tool.call({ file_path: target, content: 'hello\n' }, callContext(agent));

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello\n');
    expect(result.meta).toMatchObject({ created: true });
  });

  it('refuses to overwrite an existing file that was not read', async () => {
    const root = tempDir();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'old');
    const agent = makeAgent({ root });
    const tool = createWriteTool({ wasRead: () => false });

    await expect(
      tool.call({ file_path: file, content: 'new' }, callContext(agent)),
    ).rejects.toThrow(/read the file before overwriting/);
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
  });

  it('allows overwriting after Read recorded the path', async () => {
    const root = tempDir();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'old');
    const agent = makeAgent({ root });
    const tracker = new ReadFilesTracker();

    await createReadTool({ recordRead: (p) => tracker.add(p) }).call(
      { file_path: file },
      callContext(agent),
    );
    const result = await createWriteTool({
      wasRead: (p) => tracker.has(p),
      recordWrite: (p) => tracker.add(p),
    }).call({ file_path: file, content: 'new' }, callContext(agent));

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });

  it('rejects paths outside the granted roots', async () => {
    const root = tempDir();
    const outside = path.join(tempDir(), 'outside.txt');
    const agent = makeAgent({ root });

    await expect(
      createWriteTool().call({ file_path: outside, content: 'x' }, callContext(agent)),
    ).rejects.toThrow(/outside allowed roots/);
  });

  it('enforces the file-size limit and rejects directories', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const limited = createWriteTool({ maxFileBytes: 8 });

    await expect(
      limited.call({ file_path: path.join(root, 'big.txt'), content: 'x'.repeat(9) }, callContext(agent)),
    ).rejects.toThrow(/exceeds the 8-byte limit/);

    await expect(
      createWriteTool().call({ file_path: root, content: 'x' }, callContext(agent)),
    ).rejects.toThrow(/not a file/);
  });
});

describe('Edit tool', () => {
  function seedRead(root: string, content: string): { file: string; agent: AgentRunContext; tracker: ReadFilesTracker } {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, content);
    const agent = makeAgent({ root });
    const tracker = new ReadFilesTracker([fs.realpathSync.native(file)]);
    return { file, agent, tracker };
  }

  it('edits a unique match', async () => {
    const root = tempDir();
    const { file, agent, tracker } = seedRead(root, 'alpha beta gamma\n');
    const result = await createEditTool({
      wasRead: (p) => tracker.has(p),
      recordWrite: (p) => tracker.add(p),
    }).call(
      { file_path: file, old_string: 'beta', new_string: 'BETA' },
      callContext(agent),
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('alpha BETA gamma\n');
  });

  it('requires a prior read', async () => {
    const root = tempDir();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'alpha');
    const agent = makeAgent({ root });

    await expect(
      createEditTool({ wasRead: () => false }).call(
        { file_path: file, old_string: 'alpha', new_string: 'beta' },
        callContext(agent),
      ),
    ).rejects.toThrow(/read the file before editing/);
  });

  it('rejects ambiguous matches unless replace_all is set', async () => {
    const root = tempDir();
    const { file, agent } = seedRead(root, 'x x x');
    const tool = createEditTool();

    await expect(
      tool.call({ file_path: file, old_string: 'x', new_string: 'y' }, callContext(agent)),
    ).rejects.toThrow(/matches 3 places/);

    const replaced = await tool.call(
      { file_path: file, old_string: 'x', new_string: 'y', replace_all: true },
      callContext(agent),
    );
    expect(replaced.isError).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('y y y');
  });

  it('reports missing and unchanged edits', async () => {
    const root = tempDir();
    const { file, agent } = seedRead(root, 'alpha');

    await expect(
      createEditTool().call(
        { file_path: file, old_string: 'missing', new_string: 'x' },
        callContext(agent),
      ),
    ).rejects.toThrow(/not found/);
    await expect(
      createEditTool().call(
        { file_path: file, old_string: 'same', new_string: 'same' },
        callContext(agent),
      ),
    ).rejects.toThrow(/identical/);
  });

  it('refuses binary files', async () => {
    const root = tempDir();
    const file = path.join(root, 'bin.dat');
    fs.writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]));
    const agent = makeAgent({ root });

    await expect(
      createEditTool().call(
        { file_path: file, old_string: 'a', new_string: 'b' },
        callContext(agent),
      ),
    ).rejects.toThrow(/binary/);
  });
});

describe('ReadFilesTracker', () => {
  it('rebuilds only completed successful Read calls', () => {
    const root = tempDir();
    const ok = path.join(root, 'ok.txt');
    const failed = path.join(root, 'failed.txt');
    const unanswered = path.join(root, 'unanswered.txt');
    fs.writeFileSync(ok, 'a');
    fs.writeFileSync(failed, 'b');

    const messages = [
      nativeMessage(1, 'assistant', [
        { type: 'tool_call', id: 't1', name: 'Read', arguments: JSON.stringify({ file_path: ok }) },
        { type: 'tool_call', id: 't2', name: 'Read', arguments: JSON.stringify({ file_path: failed }) },
        { type: 'tool_call', id: 't3', name: 'Read', arguments: JSON.stringify({ file_path: unanswered }) },
      ]),
      nativeMessage(2, 'tool', [
        { type: 'tool_result', toolUseId: 't1', content: 'a', isError: false },
        { type: 'tool_result', toolUseId: 't2', content: 'denied', isError: true },
      ]),
    ];

    const tracker = ReadFilesTracker.fromTranscript(messages, root);
    expect(tracker.has(fs.realpathSync.native(ok))).toBe(true);
    expect(tracker.has(fs.realpathSync.native(failed))).toBe(false);
    expect(tracker.has(path.resolve(unanswered))).toBe(false);
  });
});

describe('Write approval', () => {
  it('asks before writing and stays put when denied', async () => {
    const root = tempDir();
    const broker = vi.fn(async (): Promise<ToolPermissionDecision> => ({ status: 'denied' }));
    const agent = makeAgent({ root, broker });
    const registry = new ToolRegistry([new NativeToolProvider([createWriteTool()])]);

    const result = await new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } },
      agent,
    );

    expect(broker).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ isError: true });
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });

  it('runs without asking under acceptEdits', async () => {
    const root = tempDir();
    const broker = vi.fn(async (): Promise<ToolPermissionDecision> => ({ status: 'denied' }));
    const agent = makeAgent({ root, permissionMode: 'acceptEdits', broker });
    const registry = new ToolRegistry([new NativeToolProvider([createWriteTool()])]);

    const result = await new ToolExecutor({ registry }).execute(
      { id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } },
      agent,
    );

    expect(broker).not.toHaveBeenCalled();
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('x');
  });
});
