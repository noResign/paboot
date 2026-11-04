import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_PROVIDERS,
  LlmError,
  createLlmRegistry,
  formatModelId,
  loadProviders,
  mergeProviderInputs,
  noneProvider,
  parseModelId,
  parseProviderInput,
  toPublicProviders,
  writeProvidersFile,
  type LlmChunk,
  type LlmMessage,
  type LlmProvider,
} from '../src/llm/index';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paboot-llm-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('model ids', () => {
  it('splits at the first colon and round-trips', () => {
    expect(parseModelId('anthropic:claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(parseModelId(' local:mo-del:1 ')).toEqual({ provider: 'local', model: 'mo-del:1' });
    expect(formatModelId('local', 'mo-del:1')).toBe('local:mo-del:1');
  });

  it('rejects malformed ids', () => {
    expect(() => parseModelId('anthropic')).toThrow(LlmError);
    expect(() => parseModelId(':model')).toThrow(LlmError);
    expect(() => parseModelId('anthropic:')).toThrow(LlmError);
    expect(() => parseModelId('Anthropic:model')).toThrow(LlmError);
    expect(() => parseModelId('anthropic:has space')).toThrow(LlmError);
  });
});

describe('neutral message content', () => {
  it('carries base64 images as a first-class content block', () => {
    const message: LlmMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    };
    expect(message.content).toHaveLength(2);
    expect(message.content[1]).toEqual({ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' });
  });
});

describe('provider catalog', () => {
  it('merges source entries over templates and replaces models wholesale', () => {
    const merged = mergeProviderInputs(BUILTIN_PROVIDERS, [
      parseProviderInput({
        id: 'anthropic',
        baseUrl: 'https://proxy.example.com',
        models: [
          { id: 'custom', contextWindow: 1000, maxOutput: 200, supportsTools: true, supportsImages: true },
        ],
      }),
      parseProviderInput({
        id: 'local',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:8080',
        models: [{ id: 'llama' }],
      }),
    ]);

    const anthropic = merged.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.baseUrl).toBe('https://proxy.example.com');
    expect(anthropic?.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    expect(anthropic?.models).toEqual([
      { id: 'custom', contextWindow: 1000, maxOutput: 200, supportsTools: true, supportsImages: true },
    ]);

    const local = merged.find((provider) => provider.id === 'local');
    expect(local?.kind).toBe('openai');
    expect(local?.baseUrl).toBe('http://127.0.0.1:8080');
    expect(local?.apiKeyEnv).toBe(null);
  });

  it('requires kind + baseUrl for a new provider and rejects bad URLs/models', () => {
    expect(() =>
      mergeProviderInputs(BUILTIN_PROVIDERS, [parseProviderInput({ id: 'new-one' })]),
    ).toThrow(LlmError);
    expect(() => parseProviderInput({ id: 'x', baseUrl: 'ftp://example.com' })).toThrow(LlmError);
    expect(() => parseProviderInput({ id: 'x', models: [{ id: 'a' }, { id: 'a' }] })).toThrow(LlmError);
    expect(() => parseProviderInput({ id: 'none', kind: 'openai', baseUrl: 'https://x.test' })).toThrow(
      LlmError,
    );
  });
});

describe('credentials', () => {
  it('loads built-ins and resolves env keys without exposing them', async () => {
    const dir = await tempDir();
    const result = await loadProviders({
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      providersFile: path.join(dir, 'providers.json'),
    });

    expect(result.warnings).toEqual([]);
    expect(result.providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai', 'deepseek']);
    const anthropic = result.providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.apiKey).toBe('sk-ant-env');
    expect(anthropic?.apiKeySource).toBe('env');

    const publicView = toPublicProviders(result.providers);
    expect(publicView.find((provider) => provider.id === 'anthropic')?.hasApiKey).toBe(true);
    expect(JSON.stringify(publicView)).not.toContain('sk-ant-env');
    expect('apiKey' in publicView[0]!).toBe(false);
  });

  it('lets providers.json override fields and its key win over env', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'providers.json');
    await writeProvidersFile(file, [
      {
        id: 'anthropic',
        baseUrl: 'https://proxy.example.com',
        apiKey: 'sk-ant-file',
      },
    ]);

    const result = await loadProviders({
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
      providersFile: file,
    });
    const anthropic = result.providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.baseUrl).toBe('https://proxy.example.com');
    expect(anthropic?.apiKey).toBe('sk-ant-file');
    expect(anthropic?.apiKeySource).toBe('file');
  });

  it('accepts inline providers and keeps malformed sources as warnings', async () => {
    const dir = await tempDir();
    const inline = JSON.stringify({
      providers: [
        { id: 'local', kind: 'openai', baseUrl: 'http://127.0.0.1:9000', apiKey: 'inline-key' },
      ],
    });
    const result = await loadProviders({
      env: { PABOOT_LLM_PROVIDERS: inline },
      providersFile: path.join(dir, 'missing.json'),
    });
    expect(result.providers.map((provider) => provider.id)).toContain('local');
    expect(result.providers.find((provider) => provider.id === 'local')?.apiKeySource).toBe('file');
    expect(result.warnings).toEqual([]);

    const brokenFile = path.join(dir, 'broken.json');
    await fs.writeFile(brokenFile, '{not json', 'utf8');
    const broken = await loadProviders({ env: {}, providersFile: brokenFile });
    expect(broken.warnings).toEqual(['providers.json is not valid JSON']);
    expect(broken.providers).toHaveLength(BUILTIN_PROVIDERS.length);
  });

  it('writes providers.json atomically with 0600 and reads the key back', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'nested', 'providers.json');
    await writeProvidersFile(file, [{ id: 'deepseek', apiKey: 'sk-ds-file' }]);

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);

    const result = await loadProviders({ env: {}, providersFile: file });
    const deepseek = result.providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.apiKey).toBe('sk-ds-file');
    expect(deepseek?.apiKeySource).toBe('file');
  });
});

describe('llm registry', () => {
  const fakeProvider: LlmProvider = {
    id: 'fake',
    kind: 'openai',
    available: true,
    async *stream(): AsyncIterable<LlmChunk> {
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'finish', reason: 'stop' };
    },
    async complete() {
      return {
        text: 'hi',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  it('none is registered, unavailable and never throws', async () => {
    const registry = createLlmRegistry();
    expect(registry.get('none')).toBe(noneProvider);
    expect(noneProvider.available).toBe(false);
    expect(registry.hasAvailableProvider()).toBe(false);

    const completion = await noneProvider.complete({
      provider: 'none',
      model: '',
      system: '',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    expect(completion.finishReason).toBe('unavailable');
    expect(completion.usage).toBeNull();

    const chunks: LlmChunk[] = [];
    for await (const chunk of noneProvider.stream({
      provider: 'none',
      model: '',
      system: '',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'finish', reason: 'unavailable' }]);
  });

  it('registers real providers, lists deterministically and resolves model ids', () => {
    const registry = createLlmRegistry([fakeProvider]);
    expect(registry.list().map((provider) => provider.id)).toEqual(['fake', 'none']);
    expect(registry.hasAvailableProvider()).toBe(true);
    expect(registry.resolveModel('fake:model-x')).toMatchObject({ provider: fakeProvider, model: 'model-x' });
    expect(() => registry.resolveModel('missing:model')).toThrow(LlmError);
    expect(() => registry.resolveModel('fake')).toThrow(LlmError);
    expect(() => registry.register(fakeProvider)).toThrow(LlmError);
  });
});
