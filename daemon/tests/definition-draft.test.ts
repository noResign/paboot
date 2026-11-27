import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app/context';
import { draftAgentDefinition, draftAgentFromIdea, DefinitionDraftError } from '../src/agents/index';
import { BuiltinModelError } from '../src/runtimes/builtin/models';
import type { LlmRequest } from '../src/llm/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeContext(): AppContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paboot-draft-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'android'));
  fs.mkdirSync(path.join(root, 'desktop'));
  return {
    db: {
      getWorkspace: (id: string) => ({ id, name: 'Paboot', path: root }),
      listEnds: () => [
        { id: 'e1', name: 'Android', summary: '移动端', notes: null, status: 'active' },
      ],
      listEndRoots: () => [path.join(root, 'android')],
    },
    knowledge: { list: () => [{ title: '构建约定' }] },
  } as unknown as AppContext;
}

function stubModel(
  captured: { request?: LlmRequest },
  text = '你是审阅助手。',
): { resolveModel: () => Promise<unknown> } {
  return {
    resolveModel: async () => ({
      provider: {
        id: 'stub',
        complete: async (request: LlmRequest) => {
          captured.request = request;
          return { text };
        },
      },
      model: 'stub-model',
    }),
  };
}

describe('draftAgentDefinition', () => {
  it('uses the name and summary', async () => {
    const captured: { request?: LlmRequest } = {};
    const result = await draftAgentDefinition(
      fakeContext(),
      { workspaceId: 'w', name: '审阅', summary: '审查改动' },
      stubModel(captured) as never,
    );
    expect(result.instructions).toBe('你是审阅助手。');
    const user = String(captured.request!.messages[0]!.content);
    expect(user).toContain('名字：审阅');
    expect(user).toContain('简介：审查改动');
    expect(user).not.toContain('工作区上下文');
  });

  it('adds structured workspace context when asked', async () => {
    const captured: { request?: LlmRequest } = {};
    await draftAgentDefinition(
      fakeContext(),
      { workspaceId: 'w', name: '审阅', includeWorkspace: true },
      stubModel(captured) as never,
    );
    const user = String(captured.request!.messages[0]!.content);
    expect(user).toContain('端「Android」');
    expect(user).toContain('构建约定');
    expect(user).toContain('顶层目录');
  });

  it('reports a missing name as 400', async () => {
    await expect(
      draftAgentDefinition(fakeContext(), { workspaceId: 'w', name: '  ' }),
    ).rejects.toMatchObject({ status: 400, code: 'name_required' });
  });

  it('reports no configured provider as 409', async () => {
    const resolveModel = vi.fn(async () => {
      throw new BuiltinModelError('no provider', 'no_provider');
    });
    const error = await draftAgentDefinition(
      fakeContext(),
      { workspaceId: 'w', name: '审阅' },
      { resolveModel },
    ).catch((err) => err);
    expect(error).toBeInstanceOf(DefinitionDraftError);
    expect(error).toMatchObject({ status: 409, code: 'no_provider' });
  });

  it('maps an abort to a 504 timeout', async () => {
    const resolveModel = async () => ({
      provider: {
        id: 'stub',
        complete: async () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
      model: 'stub-model',
    });
    await expect(
      draftAgentDefinition(fakeContext(), { workspaceId: 'w', name: '审阅' }, { resolveModel } as never),
    ).rejects.toMatchObject({ status: 504, code: 'generation_timeout' });
  });

  it('rejects an oversized name before calling the model', async () => {
    const resolveModel = vi.fn();
    await expect(
      draftAgentDefinition(
        fakeContext(),
        { workspaceId: 'w', name: 'x'.repeat(201) },
        { resolveModel } as never,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'name_too_long' });
    expect(resolveModel).not.toHaveBeenCalled();
  });
});

describe('draftAgentFromIdea', () => {
  it('parses a fenced JSON reply into name/summary/definition', async () => {
    const captured: { request?: LlmRequest } = {};
    const reply = '```json\n{"name":"审阅助手","summary":"审查改动","instructions":"你是审阅助手。"}\n```';
    const result = await draftAgentFromIdea(
      fakeContext(),
      { workspaceId: 'w', idea: '审 Android 改动' },
      stubModel(captured, reply) as never,
    );
    expect(result).toEqual({ name: '审阅助手', summary: '审查改动', instructions: '你是审阅助手。' });
    expect(String(captured.request!.messages[0]!.content)).toContain('审 Android 改动');
  });

  it('clamps an over-long name and summary to 40 characters', async () => {
    const long = 'x'.repeat(60);
    const reply = JSON.stringify({ name: long, summary: long, instructions: 'ok' });
    const result = await draftAgentFromIdea(
      fakeContext(),
      { workspaceId: 'w', idea: 'x' },
      stubModel({}, reply) as never,
    );
    expect(result.name).toHaveLength(40);
    expect(result.summary).toHaveLength(40);
  });

  it('rejects a reply that is not JSON', async () => {
    await expect(
      draftAgentFromIdea(fakeContext(), { workspaceId: 'w', idea: 'x' }, stubModel({}, 'not json') as never),
    ).rejects.toMatchObject({ status: 502, code: 'bad_response' });
  });

  it('requires an idea', async () => {
    await expect(
      draftAgentFromIdea(fakeContext(), { workspaceId: 'w', idea: '   ' }),
    ).rejects.toMatchObject({ status: 400, code: 'idea_required' });
  });
});
