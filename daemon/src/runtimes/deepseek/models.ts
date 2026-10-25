import type { ModelOption, ModelParameter } from '../types.js';

/**
 * Provider route used by the shipped ACP profile
 * (`@deepseek-ai/dsh-acp-app` defaults to `deepseek-official`).
 *
 * ACP model values are opaque to paboot: the selector value is exactly the
 * `[provider, model]` JSON array DSH returns in its `session/new` config
 * options. We keep that spelling so a value picked in the UI can be passed
 * straight back through `session/set_config_option`.
 */
export const DEEPSEEK_PROVIDER = 'deepseek-official';

const REASONING_EFFORT: ModelParameter = {
  id: 'reasoningEffort',
  label: 'Reasoning effort',
  values: [
    { id: 'off', label: 'Off' },
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
  ],
};

function modelValue(model: string): string {
  return JSON.stringify([DEEPSEEK_PROVIDER, model]);
}

/**
 * The default `deepseek-official` route's catalogue: the ACP profile's own
 * default (`deepseek-v4-flash`) plus the built-in entries DSH advertises
 * (`packages/llm/llm-deepseek/src/models.ts`). DSH can follow the provider's
 * live listing or mount third-party providers, so this static view may lag
 * behind a customized profile; leaving the session model unset always uses
 * whatever the runtime considers current.
 */
export const DEEPSEEK_MODELS: ModelOption[] = [
  { id: modelValue('deepseek-v4-flash'), label: 'DeepSeek-V4-Flash', parameters: [REASONING_EFFORT] },
  { id: modelValue('deepseek-v4-pro'), label: 'DeepSeek-V4-Pro', parameters: [REASONING_EFFORT] },
  { id: modelValue('deepseek-flash'), label: 'DeepSeek-V4.1-Flash', parameters: [REASONING_EFFORT] },
];

export function listDeepSeekModels(_env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  return DEEPSEEK_MODELS;
}

/**
 * Accept either an opaque ACP selector (`["provider","model"]`) or a bare
 * model id. Bare ids use the shipped profile's provider route.
 */
export function normalizeModelValue(model: string): string {
  try {
    const parsed: unknown = JSON.parse(model);
    if (Array.isArray(parsed) && parsed.length === 2) return model;
  } catch {
    // Not JSON: treat it as a bare model id below.
  }
  return modelValue(model);
}
