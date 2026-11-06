import { afterEach, describe, expect, it } from 'vitest';

import {
  createTokenCalibrator,
  estimateRequestTokens,
  estimateTokens,
  resetTokenCalibration,
  truncateToTokens,
} from '../src/runtimes/builtin/tokens';
import type { LlmMessage, ToolSchema } from '../src/llm/types';

afterEach(() => {
  resetTokenCalibration();
});

describe('token estimation', () => {
  it('counts Latin text at four chars/token and CJK at one token/char', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('你好')).toBe(2);
    // 2 CJK + 4 ASCII => 2 + 1
    expect(estimateTokens('你好abcd')).toBe(3);
  });

  it('prices system, messages, tool results and tool schemas for calibration', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'hello world' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file body' }],
      },
    ];
    const tools: ToolSchema[] = [
      { name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } },
    ];

    const estimate = estimateRequestTokens({ system: 'system prompt', messages, tools });
    expect(estimate.hasImages).toBe(false);
    expect(estimate.tokens).toBeGreaterThan(0);

    const withImage = estimateRequestTokens({
      system: '',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
        },
      ],
      tools: [],
    });
    expect(withImage.hasImages).toBe(true);
  });

  it('truncates to a token budget keeping head and tail', () => {
    const text = `HEAD-${'x'.repeat(2_000)}-TAIL`;
    const truncated = truncateToTokens(text, 100, {
      measure: (value) => value.length,
      marker: '[...]',
      headRatio: 0.75,
    });

    expect(truncated.length).toBeLessThanOrEqual(100);
    expect(truncated).toContain('HEAD-');
    expect(truncated).toContain('-TAIL');
    expect(truncated).toContain('[...]');
  });

  it('returns the original text when it already fits', () => {
    expect(truncateToTokens('short', 100)).toBe('short');
  });
});

describe('token calibration', () => {
  it('learns a per-model factor from real provider usage', () => {
    const calibrator = createTokenCalibrator('test:model');
    expect(calibrator.currentFactor).toBe(1);
    expect(calibrator.measure('abcd')).toBe(1);

    // Estimate said 1000, the provider actually saw 2000 => ratio 2.
    calibrator.observe(2_000, { tokens: 1_000, hasImages: false });
    expect(calibrator.currentFactor).toBeCloseTo(1.25, 5);
    expect(calibrator.measure('abcd')).toBe(2);

    // The learned factor survives within the process for the same model key.
    expect(createTokenCalibrator('test:model').currentFactor).toBeCloseTo(1.25, 5);
  });

  it('clamps outliers and ignores images or tiny estimates', () => {
    const calibrator = createTokenCalibrator('test:clamp');

    calibrator.observe(1_000_000, { tokens: 1_000, hasImages: false });
    expect(calibrator.currentFactor).toBeCloseTo(1.75, 5); // ratio clamped to 4

    calibrator.observe(1_000_000, { tokens: 1_000, hasImages: true });
    expect(calibrator.currentFactor).toBeCloseTo(1.75, 5);

    calibrator.observe(10_000, { tokens: 10, hasImages: false });
    expect(calibrator.currentFactor).toBeCloseTo(1.75, 5);
  });
});
