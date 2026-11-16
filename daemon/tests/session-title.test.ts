import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import { cleanTitle, generateSessionTitle, titleFromPrompt } from '../src/runs/session-title';

describe('titleFromPrompt', () => {
  it('uses the first non-empty line', () => {
    expect(titleFromPrompt('fix the login bug\nplease')).toBe('fix the login bug');
    expect(titleFromPrompt('\n\n  hello world  \nmore')).toBe('hello world');
  });

  it('truncates long prompts', () => {
    const title = titleFromPrompt('a'.repeat(100));
    expect(title?.length).toBe(61); // 60 chars + ellipsis
    expect(title?.endsWith('…')).toBe(true);
  });

  it('returns null for empty/whitespace prompts', () => {
    expect(titleFromPrompt('')).toBeNull();
    expect(titleFromPrompt('   \n  \n')).toBeNull();
  });
});

describe('cleanTitle', () => {
  it('strips prefixes, quotes and extra lines', () => {
    expect(cleanTitle('Title: "Beijing weather"')).toBe('Beijing weather');
    expect(cleanTitle('标题：修复登录问题')).toBe('修复登录问题');
    expect(cleanTitle('  hello\nsecond line')).toBe('hello');
    expect(cleanTitle('`refactor auth`')).toBe('refactor auth');
  });

  it('truncates long titles and rejects empties', () => {
    expect(cleanTitle('a'.repeat(100))).toBe(`${'a'.repeat(60)}…`);
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });
});

function fakeProvider(complete: LlmProvider['complete']): LlmProvider {
  return {
    id: 'fake',
    kind: 'openai',
    available: true,
    stream: async function* () {},
    complete,
  };
}

describe('generateSessionTitle', () => {
  it('asks the session model for a short tool-free title', async () => {
    let seen: LlmRequest | undefined;
    const provider = fakeProvider(async (request) => {
      seen = request;
      return { text: 'Title: "Fix login bug"', toolCalls: [], finishReason: 'stop', usage: null };
    });

    const title = await generateSessionTitle({
      provider,
      model: 'deepseek-flash',
      prompt: 'The login page throws a 500 error. Can you fix it?',
      signal: new AbortController().signal,
    });

    expect(title).toBe('Fix login bug');
    expect(seen?.model).toBe('deepseek-flash');
    expect(seen?.tools).toEqual([]);
    expect(seen?.temperature).toBe(0);
    expect(seen?.messages[0]?.content).toContain('login page');
  });

  it('skips the request when the prompt is empty', async () => {
    let calls = 0;
    const provider = fakeProvider(async () => {
      calls += 1;
      return { text: 'unused', toolCalls: [], finishReason: 'stop', usage: null };
    });
    const title = await generateSessionTitle({
      provider,
      model: 'm',
      prompt: '   \n ',
      signal: new AbortController().signal,
    });
    expect(title).toBeNull();
    expect(calls).toBe(0);
  });

  it('caps the prompt sent to the model', async () => {
    let seen: LlmRequest | undefined;
    const provider = fakeProvider(async (request) => {
      seen = request;
      return { text: 'ok', toolCalls: [], finishReason: 'stop', usage: null };
    });
    await generateSessionTitle({
      provider,
      model: 'm',
      prompt: 'x'.repeat(5_000),
      maxPromptChars: 100,
      signal: new AbortController().signal,
    });
    expect(String(seen?.messages[0]?.content)).toHaveLength(100);
  });
});
