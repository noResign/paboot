export interface FitResult {
  lines: string[];
  used: number;
  truncated: boolean;
}

/**
 * D32: measure the rendered text, then drop whole lines from the tail until it
 * fits. Never cuts a line in half, and keeps at least `keepMinimum` entries so
 * the block cannot become a bare header.
 */
export function fitLines(
  lines: readonly string[],
  maxChars: number,
  options: { keepMinimum?: number; measure?: (text: string) => number } = {},
): FitResult {
  const measure = options.measure ?? ((text: string) => text.length);
  const keepMinimum = Math.max(0, options.keepMinimum ?? 1);
  const kept = [...lines];
  let used = measure(kept.join('\n'));
  let truncated = false;

  while (used > maxChars && kept.length > keepMinimum) {
    kept.pop();
    truncated = true;
    used = measure(kept.join('\n'));
  }
  return { lines: kept, used, truncated };
}
