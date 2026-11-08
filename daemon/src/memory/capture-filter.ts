const PRIVATE_BLOCK = /<(private|no-memory)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const PRIVATE_UNCLOSED = /<(private|no-memory)\b[^>]*>[\s\S]*$/i;
const INJECTED_BLOCK = /<paboot-memory-context\b[^>]*>[\s\S]*?<\/paboot-memory-context\s*>/gi;
const INJECTED_UNCLOSED = /<paboot-memory-context\b[^>]*>[\s\S]*$/i;

/**
 * Remove content that must never become a memory source:
 * - `<private>` / `<no-memory>` spans (D30);
 * - the daemon's own `<paboot-memory-context>` injection block, so a brief or
 *   knowledge pointer cannot be captured and reinforced (self-feedback).
 *
 * Returns the text that may be captured; an empty string means "skip this
 * message". The original message row is never modified.
 */
export function filterCaptureText(raw: string): string {
  if (raw.trim() === '') return '';
  let text = raw
    .replace(INJECTED_BLOCK, '')
    .replace(INJECTED_UNCLOSED, '')
    .replace(PRIVATE_BLOCK, '')
    .replace(PRIVATE_UNCLOSED, '');
  text = text.trim();
  return text;
}

const HAS_PRIVATE_TAG = /<(private|no-memory)\b[^>]*>/i;

/** True when the text contains an explicit capture-exclusion tag. */
export function isPrivate(raw: string): boolean {
  return HAS_PRIVATE_TAG.test(raw);
}
