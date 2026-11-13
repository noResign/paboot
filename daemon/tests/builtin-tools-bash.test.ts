import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProductPermissionMode } from '../src/types/api';
import {
  createBashTool,
  defaultToolApprovalPolicy,
  SpillStore,
  type AgentRunContext,
  type ToolCallContext,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'paboot-bash-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(options: {
  root: string;
  permissionMode?: ProductPermissionMode;
  signal?: AbortSignal;
}): AgentRunContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin', role: 'coder' },
    workspace: { id: 'ws-1', name: 'Acme', family: 'dev', root: options.root },
    cwd: options.root,
    extraDirs: [],
    pathPolicy: {
      mode: 'server-strict',
      grants: [{ root: options.root, capabilities: ['read', 'write', 'list'] }],
      denyRoots: [],
    },
    permissionMode: options.permissionMode ?? 'ask',
    signal: options.signal ?? new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'denied' }) },
  } as AgentRunContext;
}

function callContext(agent: AgentRunContext): ToolCallContext {
  return { agent, signal: agent.signal, callId: 'call-1' };
}

describe('Bash tool', () => {
  it('returns stdout and the exit code', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const result = await createBashTool().call(
      { command: 'node -e "console.log(\'hello\')"' },
      callContext(agent),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
    expect(result.content).toContain('exit code: 0');
    expect(result.meta).toMatchObject({ exitCode: 0 });
  });

  it('marks a non-zero exit as an error but keeps the output', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const result = await createBashTool().call(
      { command: 'node -e "process.stderr.write(\'boom\'); process.exit(3)"' },
      callContext(agent),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
    expect(result.content).toContain('exit code: 3');
  });

  it('strips provider keys and passes only explicitly allowed env vars', async () => {
    const root = tempDir();
    const previousSecret = process.env['PABOOT_SECRET'];
    const previousAllowed = process.env['MY_ALLOWED'];
    process.env['PABOOT_SECRET'] = 'sk-leak';
    process.env['MY_ALLOWED'] = 'ok';
    try {
      const agent = makeAgent({ root });
      const result = await createBashTool({ envAllow: ['MY_ALLOWED'] }).call(
        {
          command:
            'node -e "console.log(process.env.PABOOT_SECRET ?? \'missing\'); console.log(process.env.MY_ALLOWED ?? \'missing\')"',
        },
        callContext(agent),
      );

      expect(result.content).toContain('missing');
      expect(result.content).toContain('ok');
      expect(result.content).not.toContain('sk-leak');
    } finally {
      if (previousSecret === undefined) delete process.env['PABOOT_SECRET'];
      else process.env['PABOOT_SECRET'] = previousSecret;
      if (previousAllowed === undefined) delete process.env['MY_ALLOWED'];
      else process.env['MY_ALLOWED'] = previousAllowed;
    }
  });

  it('times out and kills the process tree', async () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const started = Date.now();
    const result = await createBashTool({ defaultTimeoutMs: 100, maxTimeoutMs: 200 }).call(
      { command: 'node -e "setTimeout(() => {}, 10000)"' },
      callContext(agent),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('cancels an in-flight command when the run aborts', async () => {
    const root = tempDir();
    const controller = new AbortController();
    const agent = makeAgent({ root, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    const started = Date.now();
    const result = await createBashTool().call(
      { command: 'node -e "setTimeout(() => {}, 10000)"' },
      callContext(agent),
    );

    expect(result).toMatchObject({ isError: true, interrupted: true });
    expect(result.content).toContain('cancelled');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('spills oversized output and returns the path', async () => {
    const root = tempDir();
    const dataDir = tempDir('paboot-bash-data-');
    const spill = new SpillStore(dataDir);
    const agent = makeAgent({ root });
    const result = await createBashTool({ maxOutputBytes: 100, spill }).call(
      { command: 'node -e "process.stdout.write(\'x\'.repeat(100000))"' },
      callContext(agent),
    );

    expect(result.isError).toBe(false);
    const spilled = (result.meta as { spilled?: { stdout?: string } }).spilled?.stdout;
    expect(spilled).toBeTruthy();
    expect(result.content).toContain('full output');
    expect(fs.readFileSync(spilled!, 'utf8').length).toBe(100000);
  });
});

describe('Bash approval policy', () => {
  it('auto-allows read-only commands and asks for the rest', () => {
    const root = tempDir();
    const agent = makeAgent({ root });
    const descriptor = createBashTool().descriptor;

    expect(defaultToolApprovalPolicy.decide({ descriptor, input: { command: 'ls' }, agent })).toBe(
      'allow',
    );
    expect(
      defaultToolApprovalPolicy.decide({ descriptor, input: { command: 'rm -rf build' }, agent }),
    ).toBe('ask');
    expect(
      defaultToolApprovalPolicy.decide({ descriptor, input: { command: 'ls | xargs rm' }, agent }),
    ).toBe('ask');

    const acceptEdits = makeAgent({ root, permissionMode: 'acceptEdits' });
    expect(
      defaultToolApprovalPolicy.decide({
        descriptor,
        input: { command: 'rm -rf build' },
        agent: acceptEdits,
      }),
    ).toBe('ask');
  });
});

describe('SpillStore', () => {
  it('writes owner-only files and removes a session directory', async () => {
    const dataDir = tempDir('paboot-spill-');
    const store = new SpillStore(dataDir);
    const file = store.writeSync('session-1', 'call-1-stdout', 'hello');

    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.removeSession('session-1');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('prunes only files older than the retention window', () => {
    const dataDir = tempDir('paboot-spill-');
    const store = new SpillStore(dataDir, 7);
    const oldFile = store.writeSync('session-1', 'old', 'x');
    const newFile = store.writeSync('session-1', 'new', 'y');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    expect(store.prune()).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });
});
