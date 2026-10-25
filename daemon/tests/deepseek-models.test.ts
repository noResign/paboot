import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_MODELS,
  DEEPSEEK_PROVIDER,
  listDeepSeekModels,
  normalizeModelValue,
} from '../src/runtimes/deepseek/models';
import { createRegistry } from '../src/runtimes/registry';

describe('deepseek model catalogue', () => {
  it('uses the opaque ACP selector values for the shipped provider route', () => {
    expect(DEEPSEEK_MODELS.map((option) => option.id)).toEqual([
      JSON.stringify([DEEPSEEK_PROVIDER, 'deepseek-v4-flash']),
      JSON.stringify([DEEPSEEK_PROVIDER, 'deepseek-v4-pro']),
      JSON.stringify([DEEPSEEK_PROVIDER, 'deepseek-flash']),
    ]);
    expect(DEEPSEEK_MODELS.map((option) => option.label)).toEqual([
      'DeepSeek-V4-Flash',
      'DeepSeek-V4-Pro',
      'DeepSeek-V4.1-Flash',
    ]);
  });

  it('advertises the reasoning knob DSH accepts', () => {
    expect(DEEPSEEK_MODELS[0]?.parameters).toEqual([
      {
        id: 'reasoningEffort',
        label: 'Reasoning effort',
        values: [
          { id: 'off', label: 'Off' },
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
          { id: 'max', label: 'Max' },
        ],
      },
    ]);
    expect(listDeepSeekModels({})).toBe(DEEPSEEK_MODELS);
  });

  it('keeps opaque selectors and wraps bare model ids', () => {
    const opaque = JSON.stringify([DEEPSEEK_PROVIDER, 'deepseek-v4-pro']);
    expect(normalizeModelValue(opaque)).toBe(opaque);
    expect(normalizeModelValue('deepseek-v4-pro')).toBe(opaque);
  });

  it('is exposed through the runtime registry without spawning a process', async () => {
    await expect(createRegistry().listModels('deepseek', {})).resolves.toEqual(DEEPSEEK_MODELS);
  });
});
