import type { LlmProvider } from '../llm/types.js';

/**
 * Derive a default session title from the first user prompt: first non-empty
 * line, trimmed and capped. Returns `null` when there is nothing meaningful to
 * show (the client then falls back to its own "untitled" label).
 */
export function titleFromPrompt(prompt: string, max = 60): string | null {
  const firstLine = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!firstLine) return null;
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

export interface GenerateSessionTitleInput {
  provider: LlmProvider;
  /** Bare model name, no `<provider>:` prefix. */
  model: string;
  prompt: string;
  signal: AbortSignal;
  /** Cap for the prompt sent to the title call. */
  maxPromptChars?: number;
  maxTitleChars?: number;
}

const TITLE_SYSTEM = [
  'Write a short title for this conversation from the user message.',
  'Use at most 8 words or 20 CJK characters.',
  'Reply with the title only: no quotes, no trailing punctuation, no prefix.',
].join(' ');

/**
 * Ask the session's own model for a compact title. Costs one small tool-free
 * completion; failures return `null` so the caller keeps the default title.
 */
export async function generateSessionTitle(
  input: GenerateSessionTitleInput,
): Promise<string | null> {
  const prompt = input.prompt.trim().slice(0, input.maxPromptChars ?? 2_000);
  if (prompt.length === 0) return null;
  const completion = await input.provider.complete({
    provider: input.provider.id,
    model: input.model,
    system: TITLE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 48,
    temperature: 0,
    signal: input.signal,
  });
  return cleanTitle(completion.text, input.maxTitleChars ?? 60);
}

/** Strip the flourishes models add around a one-line title. */
export function cleanTitle(text: string, max = 60): string | null {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (!firstLine) return null;
  const withoutPrefix = firstLine.replace(/^(?:title|标题)\s*[:：]\s*/i, '');
  const withoutQuotes = withoutPrefix
    .replace(/^["'“”‘’`]+/, '')
    .replace(/["'“”‘’`]+$/, '')
    .trim();
  if (withoutQuotes.length === 0) return null;
  return withoutQuotes.length > max ? `${withoutQuotes.slice(0, max)}…` : withoutQuotes;
}
