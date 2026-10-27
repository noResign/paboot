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
