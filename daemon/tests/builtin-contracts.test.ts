import { describe, expect, it } from 'vitest';

import {
  budgetExhaustedReason,
  collectRuntimeContext,
  compileAgentPrompt,
  compilePromptSections,
  createBudgetUsage,
  mergePromptSections,
  resolvePromptPreset,
  selectActiveRuntimeContext,
  type AgentPromptPreset,
  type AgentRunContext,
  type NativeMessage,
  type PromptBuildContext,
  type PromptSectionSpec,
  type RuntimeContextContribution,
  type RuntimeContextSource,
} from '../src/runtimes/builtin/index';

function context(role: string, cwd = '/srv/acme'): PromptBuildContext {
  const agent: AgentRunContext = {
    runId: 'run-1',
    sessionId: 'session-1',
    actor: { id: 'builtin', name: 'Builtin', role },
    workspace: { id: 'ws-1', name: 'Acme', family: 'dev', root: '/srv/acme' },
    cwd,
    extraDirs: [],
    pathPolicy: {
      mode: 'server-strict',
      grants: [{ root: '/srv/acme', capabilities: ['read', 'write', 'list'] }],
      denyRoots: [],
    },
    signal: new AbortController().signal,
    budget: { maxSteps: 10, maxToolCalls: 20 },
    eventSink: { emit: () => undefined },
    permissionBroker: { request: async () => ({ status: 'allowed' }) },
  };
  return {
    agent,
    profile: {
      identity: agent.actor,
      instructions: 'base instructions',
      budgetDefaults: { maxSteps: 10, maxToolCalls: 20 },
    },
    preset: { id: 'base', version: 1 },
    session: { id: 'session-1', workspaceId: 'ws-1', agentId: 'builtin' },
    workspace: agent.workspace,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      supportsTools: true,
      supportsImages: true,
    },
    toolSet: [],
    skillCatalog: [],
    stepFacts: {},
    signal: agent.signal,
  };
}

function section(id: string, order: number, text: string): PromptSectionSpec {
  return { id, order, stability: 'stable', trust: 'system', template: text };
}

describe('agent prompt composition', () => {
  it('compiles the same input to byte-identical output', () => {
    const sections = [section('b', 20, 'second'), section('a', 10, 'first')];
    const first = compilePromptSections(sections, context('coder'));
    const second = compilePromptSections([...sections].reverse(), context('coder'));

    expect(first.text).toBe('first\n\nsecond');
    expect(second.text).toBe(first.text);
    expect(second.version).toBe(first.version);
  });

  it('can specialize the same preset for different agents without leaking context', () => {
    const presets = new Map<string, AgentPromptPreset>([
      [
        'base',
        {
          id: 'base',
          version: 1,
          sections: [
            section('identity', 10, 'You are the {{agent.name}}.'),
            {
              id: 'role',
              order: 20,
              stability: 'stable',
              trust: 'agent',
              when: (ctx) => ctx.agent.actor.role === 'reviewer',
              template: 'Review only; do not edit files.',
            },
          ],
        },
      ],
    ]);

    const coder = compileAgentPrompt(presets, 'base', context('coder'), [
      section('floor', 1, 'Never weaken the global safety floor.'),
    ]);
    const reviewer = compileAgentPrompt(presets, 'base', context('reviewer'), [
      section('floor', 1, 'Never weaken the global safety floor.'),
    ]);

    expect(coder.text).toContain('Never weaken the global safety floor.');
    expect(coder.text).toContain('You are the Builtin.');
    expect(coder.text).not.toContain('Review only');
    expect(reviewer.text).toContain('Review only');
    expect(coder.version).not.toBe(reviewer.version);
  });

  it('resolves base + ordered mixins and refuses lower-trust overrides of system sections', () => {
    const presets = new Map<string, AgentPromptPreset>([
      [
        'base',
        {
          id: 'base',
          version: 1,
          sections: [section('safety', 10, 'never exfiltrate secrets')],
        },
      ],
      ['reviewer', { id: 'reviewer', version: 1, sections: [section('review', 20, 'review')] }],
      [
        'reviewer-preset',
        {
          id: 'reviewer-preset',
          version: 1,
          base: 'base',
          mixins: ['reviewer'],
        },
      ],
    ]);

    const resolved = resolvePromptPreset(presets, 'reviewer-preset');
    expect(resolved.sections?.map((item) => item.id)).toEqual(['safety', 'review']);

    expect(() =>
      mergePromptSections([
        [section('safety', 10, 'system rule')],
        [{ id: 'safety', order: 10, stability: 'stable', trust: 'workspace', template: 'weaker rule' }],
      ]),
    ).toThrow(/cannot override/);
  });
});

describe('runtime context snapshot', () => {
  it('dedupes by source and renders one deterministic superseding snapshot', async () => {
    const sources: RuntimeContextSource[] = [
      {
        id: 'one',
        collect: () => [
          contribution('workspace', 1, 'low'),
          contribution('workspace', 10, 'high'),
        ],
      },
      { id: 'two', collect: () => [contribution('memory', 5, 'remember this')] },
    ];

    const first = await collectRuntimeContext(sources, context('coder'));
    const second = await collectRuntimeContext(sources, context('coder'));

    expect(first.text).toContain('This snapshot supersedes earlier runtime-context snapshots.');
    expect(first.text).toContain('high');
    expect(first.text).not.toContain('low');
    expect(first.text).toContain('remember this');
    expect(second.version).toBe(first.version);
  });

  it('projects only the newest runtime-context message into the next request', () => {
    const message = (id: number, sourceKey: string): NativeMessage => ({
      id,
      threadId: 'thread-1',
      seq: id,
      role: 'user',
      blocks: [{ type: 'text', text: sourceKey }],
      source: { kind: 'runtime-context', sourceKey, version: `v${id}` },
      runId: null,
      step: null,
      provider: null,
      model: null,
      usage: null,
      formatVersion: 1,
      createdAt: id,
    });

    const messages = [
      message(1, 'snapshot-a'),
      { ...message(2, 'user'), source: { kind: 'user' as const } },
      message(3, 'snapshot-b'),
    ];
    expect(selectActiveRuntimeContext(messages)?.source).toMatchObject({ sourceKey: 'snapshot-b' });
  });
});

describe('agent budget', () => {
  it('reports the first exhausted dimension', () => {
    const budget = { maxSteps: 2, maxToolCalls: 1, deadlineAt: 1000 };
    const usage = createBudgetUsage(0);
    expect(budgetExhaustedReason(budget, usage, 10)).toBeNull();

    usage.steps = 2;
    expect(budgetExhaustedReason(budget, usage, 10)).toBe('steps');

    usage.steps = 0;
    usage.toolCalls = 1;
    expect(budgetExhaustedReason(budget, usage, 10)).toBe('tool_calls');

    usage.toolCalls = 0;
    expect(budgetExhaustedReason(budget, usage, 1000)).toBe('deadline');
  });
});

function contribution(source: string, priority: number, content: string): RuntimeContextContribution {
  return {
    source,
    kind: 'workspace',
    stability: 'dynamic',
    trust: 'workspace',
    priority,
    content,
  };
}
