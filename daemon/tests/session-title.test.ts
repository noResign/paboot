import { describe, expect, it } from 'vitest';
import { titleFromPrompt } from '../src/runs/session-title';

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
