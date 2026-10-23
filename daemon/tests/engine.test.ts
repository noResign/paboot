import { describe, expect, it } from 'vitest';
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
  it.each([
    ['default', 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebSearch|WebFetch|mcp__.*'],
    ['acceptEdits', 'Bash|WebSearch|WebFetch|mcp__.*'],
  ])('passes read grants and remote approval hooks to Claude in %s mode', async (permissionMode, matcher) => {
    let claudeArgs: string[] = [];
    const run = startRun({
      id: `read-grants-${permissionMode}`,
      adapter: {
        ...fakeAdapter,
        buildArgs: (ctx) => {
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
        hookPath: '/tmp/permission-hook.js',
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
    const settings = JSON.parse(claudeArgs[settingsIndex + 1]);
    expect(settings.permissions).toEqual({ allow: ['Read', 'Grep'] });
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher,
        hooks: [{ type: 'command', command: `${process.execPath} /tmp/permission-hook.js`, timeout: 150 }],
      },
    ]);
    expect(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1]).toBe(permissionMode);
  });

  it('closes a tool call that is still in flight when the run is cancelled', async () => {
    const events: NormalizedEvent[] = [];
    const run = startRun({
      id: 'run-1',
      adapter: fakeAdapter,
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
});
