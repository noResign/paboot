import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRun } from '../src/runtimes/engine';
import { claudeAdapter } from '../src/runtimes/claude/adapter';
import { defaultCapabilities, type RuntimeAdapter } from '../src/runtimes/types';
import type { NormalizedEvent } from '../src/types/api';

/**
 * A fake runtime that opens one tool call on its first stdout chunk and then
 * idles, so the run is still alive with that tool in flight — the situation a
 * long Bash command creates.
 */
const fakeAdapter: RuntimeAdapter = {
  id: 'fake',
  name: 'Fake',
  bin: process.execPath,
  keepStdinOpen: true,
  detect: async () => ({
    id: 'fake',
    name: 'Fake',
    bin: process.execPath,
    available: true,
    version: '0.0.0',
    authed: true,
    capabilities: defaultCapabilities,
    models: [],
    error: null,
  }),
  buildArgs: () => ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
  createParser: (onEvent) => {
    let opened = false;
    return {
      feed: () => {
        if (opened) return;
        opened = true;
        onEvent({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } });
      },
      flush: () => {},
    };
  },
  encodeUserMessage: (text) => `${text}\n`,
};

describe('run event stream', () => {
  const tempDirs: string[] = [];
  function tempDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-engine-'));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['default', 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebSearch|WebFetch|mcp__.*'],
    ['acceptEdits', 'Bash|WebSearch|WebFetch|mcp__.*'],
  ])('passes read grants and remote approval hooks to Claude in %s mode', async (permissionMode, matcher) => {
    const hookPath = path.join(os.tmpdir(), 'permission-hook.js');
    let claudeArgs: string[] = [];
    let settingsPath: string | undefined;
    let settings: { permissions: unknown; hooks: { PreToolUse: unknown } };
    const run = startRun({
      id: `read-grants-${permissionMode}`,
      dataDir: tempDataDir(),
      adapter: {
        ...fakeAdapter,
        buildArgs: (ctx) => {
          settingsPath = ctx.permissionHook?.settingsPath;
          if (settingsPath) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          claudeArgs = claudeAdapter.buildArgs(ctx);
          return ['-e', 'process.exit(0)'];
        },
      },
      prompt: 'hi',
      cwd: process.cwd(),
      permissionMode,
      capabilities: { ...defaultCapabilities, permissionHook: true },
      env: process.env,
      permissionHook: {
        hookPath,
        daemonUrl: 'http://127.0.0.1:1',
        token: 'test-token',
        timeoutMs: 120_000,
        matcher,
      },
      onEvent: () => {},
    });
    expect((await run.promise).status).toBe('succeeded');
    const settingsIndex = claudeArgs.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThan(-1);
    // The adapter receives the file path, never the inline JSON.
    expect(settingsPath).toBeTruthy();
    expect(claudeArgs[settingsIndex + 1]).toBe(settingsPath);
    expect(settings!.permissions.allow).toEqual([
      'Read',
      'Grep',
      'mcp__paboot_memory__*',
      'mcp__paboot_capability__*',
    ]);
    // Task tools still go through the PreToolUse hook.
    expect(settings!.permissions.allow).not.toContain('mcp__paboot_tasks__schedule_task');
    expect(settings!.hooks.PreToolUse).toEqual([
      {
        matcher,
        hooks: [
          {
            type: 'command',
            // Quoted so install paths containing spaces survive cmd.exe/Git Bash.
            command: `"${process.execPath}" "${hookPath}"`,
            timeout: 150,
          },
        ],
      },
    ]);
    // Cleaned up once the run ends.
    expect(fs.existsSync(settingsPath!)).toBe(false);
    expect(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1]).toBe(permissionMode);
  });

  it('closes a tool call that is still in flight when the run is cancelled', async () => {
    const events: NormalizedEvent[] = [];
    const run = startRun({
      id: 'run-1',
      adapter: fakeAdapter,
      dataDir: tempDataDir(),
      prompt: 'hi',
      cwd: process.cwd(),
      permissionMode: 'default',
      capabilities: defaultCapabilities,
      env: process.env,
      onEvent: (ev) => events.push(ev),
    });

    const deadline = Date.now() + 2000;
    while (!events.some((e) => e.type === 'tool_use') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((e) => e.type === 'tool_use')).toBe(true);

    run.cancel('cancelled in test');
    const outcome = await run.promise;

    expect(outcome.status).toBe('cancelled');
    // The runtime never reported a result for `tool-1` (its process was killed
    // mid-call), so the engine has to synthesize one. Without it the stream
    // ends on an unmatched `tool_use`: clients render that as a forever-running
    // card, and the persisted replay keeps the state.
    const result = events.findIndex((e) => e.type === 'tool_result');
    expect(events[result]).toMatchObject({ toolUseId: 'tool-1', interrupted: true, isError: true });
    expect(result).toBeGreaterThan(events.findIndex((e) => e.type === 'tool_use'));
  });

  it('persists the native session id only after the runtime emits init', async () => {
    const onNativeSessionId = vi.fn();
    const adapter: RuntimeAdapter = {
      ...fakeAdapter,
      buildArgs: () => ['-e', 'console.log("ready")'],
      createParser: (onEvent) => ({
        feed: () => onEvent({ type: 'status', label: 'initializing', sessionId: 'native-1' }),
        flush: () => {},
      }),
    };
    const run = startRun({
      id: 'native-init',
      adapter,
      dataDir: tempDataDir(),
      prompt: 'hi',
      cwd: process.cwd(),
      newSessionId: 'generated-id',
      permissionMode: 'default',
      capabilities: defaultCapabilities,
      env: process.env,
      onNativeSessionId,
      onEvent: () => {},
    });

    expect(await run.promise).toMatchObject({ status: 'succeeded' });
    expect(onNativeSessionId).toHaveBeenCalledTimes(1);
    expect(onNativeSessionId).toHaveBeenCalledWith('native-1');
  });

  it('does not leave a native id behind when the run fails before init', async () => {
    const onNativeSessionId = vi.fn();
    const adapter: RuntimeAdapter = {
      ...fakeAdapter,
      buildArgs: () => ['-e', 'process.exit(1)'],
      createParser: () => ({ feed: () => {}, flush: () => {} }),
    };
    const run = startRun({
      id: 'native-init-missing',
      adapter,
      dataDir: tempDataDir(),
      prompt: 'hi',
      cwd: process.cwd(),
      newSessionId: 'generated-id',
      permissionMode: 'default',
      capabilities: defaultCapabilities,
      env: process.env,
      onNativeSessionId,
      onEvent: () => {},
    });

    expect((await run.promise).status).toBe('failed');
    expect(onNativeSessionId).not.toHaveBeenCalled();
  });
});
