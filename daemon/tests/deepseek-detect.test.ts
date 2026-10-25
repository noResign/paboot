import { describe, expect, it } from 'vitest';
import { DEEPSEEK_BIN, detectDeepSeek } from '../src/runtimes/deepseek/detect';

describe('detectDeepSeek', () => {
  it('uses the same PATH-resolved npm bin as the other CLIs', () => {
    expect(DEEPSEEK_BIN).toBe('dsh');
  });

  it('reports a missing CLI with an actionable install hint', async () => {
    const detection = await detectDeepSeek('/nonexistent/paboot-dsh-does-not-exist', {});

    expect(detection).toMatchObject({
      id: 'deepseek',
      name: 'DeepSeek Harness',
      available: false,
      version: null,
      models: [],
    });
    expect(detection.error).toContain('npm install -g @deepseek-ai/dsh');
  });
});
