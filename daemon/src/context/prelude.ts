import { assembleContext } from './assembler.js';
import type { ContextSection } from './types.js';

/**
 * K0 knowledge is pointer-only, so it is small. The cap exists to keep a
 * pathological document list from flooding the first turn; the assembler drops
 * whole sections, never a half-section.
 */
export const DEFAULT_CONTEXT_BUDGET = 6000;

/** Stable wrapper used later by the capture filter to strip injected context. */
export const MEMORY_CONTEXT_OPEN = '<paboot-memory-context>';
export const MEMORY_CONTEXT_CLOSE = '</paboot-memory-context>';

export interface ContextPrelude {
  /** The block to prepend to the user prompt, wrapper included. */
  prefix: string;
  used: number;
  overBudget: boolean;
  omitted: number;
}

/**
 * Assemble provider sections and wrap them in the stable marker. Returns `null`
 * when there is nothing to inject, so callers can keep the original prompt
 * byte-for-byte (important for prompt caching).
 */
/**
 * Merge multiple wrapped preludes into one marker block. A single non-null
 * input is returned unchanged so unchanged runs stay byte-identical.
 */
export function mergePreludes(
  ...parts: (ContextPrelude | null | undefined)[]
): ContextPrelude | null {
  const present = parts.filter((part): part is ContextPrelude => part !== null && part !== undefined);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0]!;

  const inner = present.map((part) => unwrap(part.prefix)).filter((text) => text !== '').join('\n\n');
  if (inner === '') return null;
  return {
    prefix: `${MEMORY_CONTEXT_OPEN}\n${inner}\n${MEMORY_CONTEXT_CLOSE}`,
    used: present.reduce((sum, part) => sum + part.used, 0),
    overBudget: present.some((part) => part.overBudget),
    omitted: present.reduce((sum, part) => sum + part.omitted, 0),
  };
}

function unwrap(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.startsWith(MEMORY_CONTEXT_OPEN) && trimmed.endsWith(MEMORY_CONTEXT_CLOSE)) {
    return trimmed.slice(MEMORY_CONTEXT_OPEN.length, -MEMORY_CONTEXT_CLOSE.length).trim();
  }
  return trimmed;
}

export function renderContextPrelude(
  sections: readonly ContextSection[],
  runtime: string,
  budget: number = DEFAULT_CONTEXT_BUDGET,
): ContextPrelude | null {
  const assembled = assembleContext(sections, { runtime, budget });
  if (!assembled.text.trim()) return null;
  return {
    prefix: `${MEMORY_CONTEXT_OPEN}\n${assembled.text}\n${MEMORY_CONTEXT_CLOSE}`,
    used: assembled.used,
    overBudget: assembled.overBudget,
    omitted: assembled.omitted.length,
  };
}
