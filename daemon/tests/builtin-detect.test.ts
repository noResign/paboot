import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeProvidersFile } from '../src/llm/credentials';
import { detectBuiltin } from '../src/runtimes/builtin/detect';
import { createRegistry } from '../src/runtimes/registry';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function env(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paboot-builtin-detect-'));
  tempDirs.push(dir);
  return {
    PABOOT_LLM_PROVIDERS_FILE: path.join(dir, 'providers.json'),
    ...extra,
  };
}

describe('builtin detection', () => {
  it('is explicitly unavailable without a provider key', async () => {
    const detection = await detectBuiltin(await env());
    expect(detection).toMatchObject({
      id: 'builtin',
      available: false,
      authed: false,
      models: [],
    });
    expect(detection.error).toContain('no LLM provider configured');
  });

  it('appears when a key and enabled model are configured', async () => {
    const detection = await detectBuiltin(await env({ ANTHROPIC_API_KEY: 'sk-test' }));
    expect(detection.available).toBe(true);
    expect(detection.authed).toBe(true);
    expect(detection.models).toContainEqual({
      id: 'anthropic:claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      supportsImages: true,
    });
    expect(detection.error).toBeNull();
  });

  it('exposes DeepSeek Flash as a vision-capable configured model', async () => {
    const detection = await detectBuiltin(await env({ DEEPSEEK_API_KEY: 'sk-test' }));
    expect(detection.available).toBe(true);
    expect(detection.models).toContainEqual({
      id: 'deepseek:deepseek-flash',
      label: 'DeepSeek Flash',
      supportsImages: true,
    });
  });

  it('honours models from providers.json and excludes disabled models', async () => {
    const runtimeEnv = await env({ ANTHROPIC_API_KEY: 'sk-test' });
    await writeProvidersFile(runtimeEnv.PABOOT_LLM_PROVIDERS_FILE!, [
      {
        id: 'anthropic',
        models: [
          { id: 'custom-model', label: 'Custom', supportsTools: true },
          { id: 'disabled-model', label: 'Disabled', enabled: false },
        ],
      },
    ]);

    const detection = await detectBuiltin(runtimeEnv);
    expect(detection.available).toBe(true);
    expect(detection.models).toEqual([{ id: 'anthropic:custom-model', label: 'Custom' }]);
  });

  it('keeps builtin in the runtime registry', () => {
    expect(createRegistry().list()).toContainEqual(
      expect.objectContaining({
        id: 'builtin',
        name: 'Builtin',
        bin: 'builtin',
      }),
    );
  });
});
