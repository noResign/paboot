import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KnowledgeStore } from '../src/knowledge/store';
import {
  assembleAgentContext,
  builtinGlobalPromptSections,
  collectRuntimeContext,
  compilePromptSections,
  EnvironmentContextSource,
  ProjectDocsContextSource,
  WorkspaceKnowledgeContextSource,
  type AgentContextProfile,
  type AgentPromptPreset,
  type AgentRunContext,
  type PromptBuildContext,
  type PromptSectionSpec,
  type RuntimeContextCollectContext,
  type RuntimeContextSource,
} from '../src/runtimes/builtin/index';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'paboot-context-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeContext(options: {
  role?: string;
  workspaceRoot: string;
  cwd?: string;
  now?: number;
}): { prompt: PromptBuildContext; runtime: RuntimeContextCollectContext } {
  const role = options.role ?? 'coder';
  const agent: AgentRunContext = {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin', role },
    workspace: {
      id: 'ws-1',
      name: 'Acme',
      family: 'dev',
      root: options.workspaceRoot,
    },
    cwd: options.cwd ?? options.workspaceRoot,
    extraDirs: [],
    pathPolicy: {
      mode: 'server-strict',
      grants: [{ root: options.workspaceRoot, capabilities: ['read', 'write', 'list'] }],
      denyRoots: [],
    },
    signal: new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'allowed' }) },
  };
  const profile = {
    identity: agent.actor,
    instructions: 'base',
    budgetDefaults: { maxSteps: 10, maxToolCalls: 20 },
  };
  const session = { id: 'session-1', workspaceId: 'ws-1', agentId: 'builtin', endId: null };
  const model = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    supportsTools: true,
    supportsImages: true,
  };
  return {
    prompt: {
      agent,
      profile,
      preset: { id: 'base', version: 1 },
      session,
      workspace: agent.workspace,
      model,
      toolSet: [],
      skillCatalog: [],
      stepFacts: {},
      signal: agent.signal,
    },
    runtime: {
      agent,
      profile,
      session,
      model,
      toolSet: [],
      skillCatalog: [],
      signal: agent.signal,
      now: options.now ?? Date.UTC(2026, 10, 5, 12, 0, 0),
    },
  };
}

function section(id: string, order: number, text: string): PromptSectionSpec {
  return { id, order, stability: 'stable', trust: 'system', template: text };
}

describe('P3.3 context sources', () => {
  it('renders deterministic environment facts', () => {
    const { runtime } = makeContext({
      workspaceRoot: tempDir(),
      now: Date.UTC(2026, 10, 5, 12, 34, 56),
    });
    const [contribution] = new EnvironmentContextSource().collect(runtime);
    expect(contribution?.source).toBe('environment');
    expect(contribution?.content).toContain('workspace: Acme (ws-1)');
    expect(contribution?.content).toContain('time (UTC): 2026-11-05T12:34:56.000Z');
  });

  it('loads project-root CLAUDE.md and AGENTS.md once, from a nested cwd', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude instructions\nUse pnpm.');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agent instructions\nRun tests.');
    const { runtime } = makeContext({ workspaceRoot: root, cwd: path.join(root, 'src') });

    const contributions = await new ProjectDocsContextSource().collect(runtime);
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      source: 'project-docs',
      kind: 'project',
      trust: 'workspace',
    });
    expect(contributions[0]?.content).toContain('### CLAUDE.md');
    expect(contributions[0]?.content).toContain('Use pnpm.');
    expect(contributions[0]?.content).toContain('### AGENTS.md');
    expect(contributions[0]?.content).toContain('Run tests.');
  });

  it('deduplicates identical project files and truncates oversized files', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'same instructions');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'same instructions');
    const once = await new ProjectDocsContextSource({ maxFileBytes: 1_024 }).collect(
      makeContext({ workspaceRoot: root }).runtime,
    );
    expect(once[0]?.content.match(/same instructions/g)).toHaveLength(1);

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x'.repeat(100));
    const truncated = await new ProjectDocsContextSource({ maxFileBytes: 10 }).collect(
      makeContext({ workspaceRoot: root }).runtime,
    );
    expect(truncated[0]?.content).toContain('[truncated at 10 bytes]');
  });

  it('caps the combined project docs so the runtime-context budget keeps them', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x'.repeat(30_000));
    const { runtime } = makeContext({ workspaceRoot: root });

    const capped = await new ProjectDocsContextSource({ maxTokens: 2_500 }).collect(runtime);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.content).toContain('[project docs truncated to fit the 2500-token budget]');

    const snapshot = await collectRuntimeContext(
      [new EnvironmentContextSource(), new ProjectDocsContextSource()],
      runtime,
      { maxTokens: 8_000 },
    );
    expect(snapshot.contributions.map((item) => item.source)).toContain('project-docs');
    expect(snapshot.omitted.some((item) => item.source === 'project-docs')).toBe(false);
  });

  it('turns K0 confirmed documents into pointer-only knowledge contributions', () => {
    const dataDir = tempDir();
    const knowledge = new KnowledgeStore(dataDir);
    knowledge.create('ws-1', {
      title: 'Build conventions',
      body: '# build\n\nUse pnpm.\n\nUNIQUE_BODY_MARKER_123',
      kind: 'convention',
    });
    const { runtime } = makeContext({ workspaceRoot: tempDir('paboot-context-repo-') });
    const contributions = new WorkspaceKnowledgeContextSource(knowledge).collect(runtime);

    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      source: 'knowledge:workspace',
      kind: 'knowledge',
      trust: 'workspace',
    });
    expect(contributions[0]?.content).toContain('Build conventions');
    expect(contributions[0]?.content).toContain('v=');
    expect(contributions[0]?.content).not.toContain('UNIQUE_BODY_MARKER_123');
  });
});

describe('P3.3 dual-channel assembly', () => {
  it('isolates system and runtime context between agents while sharing the global floor', async () => {
    const presets = new Map<string, AgentPromptPreset>([
      [
        'coder',
        {
          id: 'coder',
          version: 1,
          sections: [
            {
              id: 'role',
              order: 10,
              stability: 'stable',
              trust: 'agent',
              template: 'You are the coder.',
            },
          ],
        },
      ],
      [
        'reviewer',
        {
          id: 'reviewer',
          version: 3,
          sections: [
            {
              id: 'role',
              order: 10,
              stability: 'stable',
              trust: 'agent',
              template: 'You are the reviewer.',
            },
          ],
        },
      ],
    ]);
    const root = tempDir();
    const coderContext = makeContext({ role: 'coder', workspaceRoot: root });
    const reviewerContext = makeContext({ role: 'reviewer', workspaceRoot: root });
    const profile = (presetId: string): AgentContextProfile => ({
      agentId: presetId,
      promptPreset: presets.get(presetId)!,
      contextSources: [new EnvironmentContextSource()],
    });

    const coder = await assembleAgentContext({
      profile: profile('coder'),
      presets,
      globalSections: builtinGlobalPromptSections(),
      promptContext: coderContext.prompt,
      runtimeContextContext: coderContext.runtime,
      runtimeContextTokenBudget: 2_000,
    });
    const reviewer = await assembleAgentContext({
      profile: profile('reviewer'),
      presets,
      globalSections: builtinGlobalPromptSections(),
      promptContext: reviewerContext.prompt,
      runtimeContextContext: reviewerContext.runtime,
      runtimeContextTokenBudget: 2_000,
    });

    expect(coder.system.text).toContain("paboot's builtin agent");
    expect(coder.system.text).toContain('You are the coder.');
    expect(coder.system.text).not.toContain('You are the reviewer.');
    expect(reviewer.system.text).toContain('You are the reviewer.');
    expect(reviewer.system.text).not.toContain('You are the coder.');
    expect(reviewer.system.text).toContain('Tool calls and filesystem access');
    expect(coder.runtimeContext.text).toContain('Runtime environment');
    expect(coder.contextVersion).not.toBe(reviewer.contextVersion);
    expect(reviewer.presetVersion).toBe(3);
  });

  it('drops non-system system sections to fit the total system budget', () => {
    const ctx = makeContext({ workspaceRoot: tempDir() }).prompt;
    const result = compilePromptSections(
      [
        section('global', 1, 'critical policy'),
        {
          id: 'large',
          order: 2,
          stability: 'dynamic',
          trust: 'workspace',
          template: 'x'.repeat(100),
        },
      ],
      ctx,
      { maxTokens: 20, measure: (text) => text.length },
    );
    expect(result.text).toBe('critical policy');
    expect(result.overBudget).toBe(true);
    expect(result.omitted).toContainEqual({ id: 'large', reason: 'budget' });
  });

  it('drops low-priority runtime context and reports source errors without failing the run', async () => {
    const low: RuntimeContextSource = {
      id: 'low',
      collect: () => [
        {
          source: 'low',
          kind: 'other',
          stability: 'dynamic',
          trust: 'workspace',
          priority: 1,
          content: 'low priority',
        },
      ],
    };
    const broken: RuntimeContextSource = {
      id: 'broken',
      collect: () => {
        throw new Error('boom');
      },
    };
    const high: RuntimeContextSource = {
      id: 'high',
      collect: () => [
        {
          source: 'high',
          kind: 'other',
          stability: 'dynamic',
          trust: 'workspace',
          priority: 100,
          content: 'high priority',
        },
      ],
    };
    const snapshot = await collectRuntimeContext(
      [low, high, broken],
      makeContext({ workspaceRoot: tempDir() }).runtime,
      { maxTokens: 13, measure: (text) => text.length },
    );

    expect(snapshot.contributions.map((item) => item.source)).toEqual(['high']);
    expect(snapshot.text).toContain('high priority');
    expect(snapshot.overBudget).toBe(true);
    expect(snapshot.omitted).toContainEqual({ source: 'low', reason: 'budget' });
    expect(snapshot.omitted).toContainEqual({ source: 'broken', reason: 'source_error' });
  });
});
