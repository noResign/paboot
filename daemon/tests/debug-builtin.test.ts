import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import type { AgentContextAssembly } from '../src/runtimes/builtin/context/assembly';
import { AgentKernel, type KernelStepDebugRecord } from '../src/runtimes/builtin/kernel/agent';
import type { TranscriptStore } from '../src/runtimes/builtin/transcript/store';
import type { AgentRunContext } from '../src/runtimes/builtin/types';
import type { TokenCalibrator } from '../src/runtimes/builtin/tokens';

function fakeProvider(calls: LlmRequest[]): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    unavailableReason: undefined,
    async *stream(request) {
      calls.push(request);
      yield { type: 'finish', reason: 'stop' };
    },
    async complete() {
      throw new Error('not used');
    },
  } as unknown as LlmProvider;
}

function fakeTranscript(): TranscriptStore {
  let seq = 0;
  return {
    getOrCreateThread: () => ({ id: 't-1', sessionId: 's-1', agentId: 'builtin' }) as never,
    getThread: () => undefined,
    append: (input) => {
      seq += 1;
      return { ...input, id: seq, seq } as never;
    },
    list: () => [],
    latestContext: () => null,
    appendCompaction: () => ({}) as never,
    listCompactions: () => [],
  } as unknown as TranscriptStore;
}

function assembly(): AgentContextAssembly {
  return {
    agentId: 'builtin',
    presetId: 'builtin-default',
    presetVersion: 1,
    contextVersion: 'ctx-1',
    system: {
      stableText: 'stable',
      dynamicText: 'dynamic',
      text: 'SYSTEM PROMPT',
      sections: [
        { id: 'global.safety', order: 1, stability: 'stable', trust: 'system', text: 'SYSTEM PROMPT' },
      ],
      omitted: [],
      overBudget: false,
      version: 'sys-1',
    },
    runtimeContext: {
      text: 'RUNTIME CONTEXT',
      contributions: [
        {
          source: 'memory:brief',
          kind: 'memory',
          stability: 'dynamic',
          trust: 'workspace',
          priority: 8,
          content: 'brief body',
        },
      ],
      omitted: [],
      overBudget: false,
      version: 'rt-1',
    },
  };
}

function agentContext(): AgentRunContext {
  return {
    runId: 'r-1',
    sessionId: 's-1',
    actor: { id: 'builtin', name: 'Builtin', role: 'assistant' },
    workspace: { id: 'w-1', name: 'w', family: 'dev' },
    cwd: '/tmp',
    extraDirs: [],
    pathPolicy: { mode: 'local', grants: [], denyRoots: [] },
    permissionMode: 'ask',
    signal: new AbortController().signal,
    budget: { maxSteps: 3, maxToolCalls: 3 },
    eventSink: { emit: () => undefined },
    permissionBroker: {} as never,
  } as unknown as AgentRunContext;
}

function calibrator(): TokenCalibrator {
  return {
    measure: (text: string) => text.length,
    observe: () => undefined,
  } as unknown as TokenCalibrator;
}

describe('builtin step debug', () => {
  it('records the exact request before each model call', async () => {
    const calls: LlmRequest[] = [];
    const records: KernelStepDebugRecord[] = [];
    const kernel = new AgentKernel({
      provider: fakeProvider(calls),
      model: 'fake-1',
      modelSnapshot: { provider: 'fake', model: 'fake-1', supportsTools: false, supportsImages: false },
      threadId: 't-1',
      transcript: fakeTranscript(),
      toolDescriptors: [],
      toolExecutor: {} as never,
      assembleContext: async () => assembly(),
      tokenCalibrator: calibrator(),
      debugStep: (record) => records.push(record),
    });

    const result = await kernel.run(agentContext());

    expect(result.status).toBe('succeeded');
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      runId: 'r-1',
      step: 1,
      provider: 'fake',
      model: 'fake-1',
    });
    expect(record.request.system).toBe('SYSTEM PROMPT');
    expect(record.context.runtimeContext.text).toBe('RUNTIME CONTEXT');
    expect(record.estimatedTokens).toBeGreaterThan(0);
    expect(calls[0]).toBe(record.request);
  });

  it('never lets a debug failure break the run', async () => {
    const kernel = new AgentKernel({
      provider: fakeProvider([]),
      model: 'fake-1',
      modelSnapshot: { provider: 'fake', model: 'fake-1', supportsTools: false, supportsImages: false },
      threadId: 't-1',
      transcript: fakeTranscript(),
      toolDescriptors: [],
      toolExecutor: {} as never,
      assembleContext: async () => assembly(),
      tokenCalibrator: calibrator(),
      debugStep: () => {
        throw new Error('debug sink exploded');
      },
    });

    await expect(kernel.run(agentContext())).resolves.toMatchObject({ status: 'succeeded' });
  });
});
