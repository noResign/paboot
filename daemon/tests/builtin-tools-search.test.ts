import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createGlobTool,
  createGrepTool,
  createTodoTool,
  type AgentRunContext,
  type ToolCallContext,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'paboot-search-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(root: string): AgentRunContext {
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
    permissionMode: 'ask',
    signal: new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'denied' }) },
  } as AgentRunContext;
}

function callContext(agent: AgentRunContext): ToolCallContext {
  return { agent, signal: agent.signal, callId: 'call-1' };
}

function write(root: string, relative: string, body: string): void {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function seedTree(): string {
  const root = tempDir();
  write(root, 'src/a.ts', 'export const alpha = 1;\n// nothing\n');
  write(root, 'src/b.ts', 'const Gamma = 2;\nconst alpha = 3;\n');
  write(root, 'docs/readme.md', 'alpha in docs\n');
  write(root, 'node_modules/pkg/x.ts', 'alpha in a dependency\n');
  return root;
}

describe('Grep tool', () => {
  it('finds files, content lines and counts while skipping ignored dirs', async () => {
    const root = seedTree();
    const agent = makeAgent(root);
    const grep = createGrepTool({ preferRg: false });

    const files = await grep.call({ pattern: 'alpha' }, callContext(agent));
    expect(files.isError).toBe(false);
    expect(files.content).toContain(path.join(root, 'src', 'a.ts'));
    expect(files.content).toContain(path.join(root, 'src', 'b.ts'));
    expect(files.content).toContain(path.join(root, 'docs', 'readme.md'));
    expect(files.content).not.toContain('node_modules');

    const content = await grep.call(
      { pattern: 'alpha', path: path.join(root, 'src'), output_mode: 'content' },
      callContext(agent),
    );
    expect(content.content).toContain(`${path.join(root, 'src', 'a.ts')}:1:`);
    expect(content.content).toContain(`${path.join(root, 'src', 'b.ts')}:2:`);

    const count = await grep.call(
      { pattern: 'alpha', output_mode: 'count' },
      callContext(agent),
    );
    expect(count.content).toContain(`${path.join(root, 'src', 'a.ts')}:1`);
    expect(count.content).toContain(`${path.join(root, 'src', 'b.ts')}:1`);
  });

  it('supports glob filters, case-insensitive matching and empty results', async () => {
    const root = seedTree();
    const agent = makeAgent(root);
    const grep = createGrepTool({ preferRg: false });

    const tsOnly = await grep.call({ pattern: 'alpha', glob: '*.ts' }, callContext(agent));
    expect(tsOnly.content).not.toContain('readme.md');

    const gamma = await grep.call(
      { pattern: 'gamma', case_insensitive: true },
      callContext(agent),
    );
    expect(gamma.content).toContain(path.join(root, 'src', 'b.ts'));

    const none = await grep.call({ pattern: 'does-not-exist' }, callContext(agent));
    expect(none.content).toBe('No matches found.');
  });

  it('rejects paths outside the granted roots and invalid patterns', async () => {
    const root = tempDir();
    const outside = tempDir();
    const agent = makeAgent(root);
    const grep = createGrepTool({ preferRg: false });

    await expect(
      grep.call({ pattern: 'x', path: outside }, callContext(agent)),
    ).rejects.toThrow(/outside allowed roots/);
    await expect(
      grep.call({ pattern: '(' }, callContext(agent)),
    ).rejects.toThrow(/invalid regular expression/);
  });
});

describe('Glob tool', () => {
  it('finds files by pattern and caps the result count', async () => {
    const root = seedTree();
    const agent = makeAgent(root);

    const all = await createGlobTool().call({ pattern: '**/*.ts' }, callContext(agent));
    expect(all.isError).toBe(false);
    expect(all.content).toContain(path.join(root, 'src', 'a.ts'));
    expect(all.content).toContain(path.join(root, 'src', 'b.ts'));

    const capped = await createGlobTool({ maxResults: 1 }).call(
      { pattern: '**/*.ts' },
      callContext(agent),
    );
    expect(capped.meta).toMatchObject({ files: 1, truncated: true });
  });

  it('rejects absolute and parent-relative patterns', async () => {
    const root = tempDir();
    const agent = makeAgent(root);
    const glob = createGlobTool();

    await expect(glob.call({ pattern: '/etc/passwd' }, callContext(agent))).rejects.toThrow(
      /relative/,
    );
    await expect(glob.call({ pattern: '../x' }, callContext(agent))).rejects.toThrow(/relative/);
  });
});

describe('TodoWrite tool', () => {
  it('validates the Claude-compatible shape and renders the list', () => {
    const tool = createTodoTool();
    const agent = makeAgent(tempDir());

    const result = tool.call(
      {
        todos: [
          { content: 'write tests', status: 'in_progress', activeForm: 'writing tests' },
          { content: 'run tests', status: 'pending', activeForm: 'running tests' },
        ],
      },
      callContext(agent),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('[in_progress] write tests');
  });

  it('rejects invalid statuses', () => {
    const tool = createTodoTool();
    const agent = makeAgent(tempDir());
    expect(() =>
      tool.call(
        { todos: [{ content: 'x', status: 'done', activeForm: 'doing' }] },
        callContext(agent),
      ),
    ).toThrow(/invalid status/);
  });
});
