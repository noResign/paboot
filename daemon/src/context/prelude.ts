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
