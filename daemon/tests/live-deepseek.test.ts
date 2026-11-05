import { describe, expect, it } from 'vitest';

import { OpenAIProvider } from '../src/llm/openai';

/**
 * Opt-in live provider smoke test:
 *
 *   PABOOT_LIVE_DEEPSEEK_API=1 DEEPSEEK_API_KEY=... pnpm test -- tests/live-deepseek.test.ts
 *
 * The key is read only from the environment; it must never be committed.
 */
const live = process.env.PABOOT_LIVE_DEEPSEEK_API === '1' && Boolean(process.env.DEEPSEEK_API_KEY);
const liveDescribe = live ? describe : describe.skip;

// 1x1 PNG (valid raster header and payload).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

liveDescribe('live DeepSeek provider', () => {
  it('completes text and image prompts with deepseek-flash', async () => {
    const provider = new OpenAIProvider({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY!,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 90_000,
    });
    const signal = new AbortController().signal;

    const text = await provider.complete({
      provider: 'deepseek',
      model: 'deepseek-flash',
      system: 'Answer briefly.',
      messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
      tools: [],
      maxTokens: 512,
      signal,
    });
    expect(text.finishReason).toBe('stop');
    expect(text.text.trim().length).toBeGreaterThan(0);

    const image = await provider.complete({
      provider: 'deepseek',
      model: 'deepseek-flash',
      system: 'Answer with one short word.',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this image?' },
          { type: 'image', mediaType: 'image/png', data: PNG_1X1.toString('base64') },
        ],
      }],
      tools: [],
      maxTokens: 512,
      signal,
    });
    expect(image.finishReason).toBe('stop');
    expect(image.text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
