/**
 * 共享上下文装配的契约（P0.3）。
 *
 * The assembler owns section order, dedupe and budget. Providers (Knowledge,
 * Memory, the runtimes) only supply sections and never merge or truncate on
 * their own — otherwise every provider would invent its own injection rules.
 */

/**
 * Fixed injection order. `runtime` comes first because it is the part the
 * runtime itself owns; it is **builtin-only** (see {@link ContextAssemblyOptions.runtime}).
 */
export const CONTEXT_KIND_ORDER = [
  'runtime',
  'workspace',
  'end',
  'requirements',
  'memory',
  'task',
] as const;

export type ContextSectionKind = (typeof CONTEXT_KIND_ORDER)[number];

/** Where a section came from; dedupe is by `source`, not by kind. */
export type ContextScope = 'runtime' | 'user' | 'workspace' | 'end' | 'session';

export interface ContextSection {
  kind: ContextSectionKind;
  scope: ContextScope;
  /** Higher wins inside a kind and when competing for budget. */
  priority: number;
  /**
   * Optional cap for this section, in the assembler's measure unit (characters
   * by default, per D32). A provider that knows its own limit sets it; the
   * assembler drops the whole section if it does not fit (never cuts it in half).
   */
  tokenBudget?: number;
  content: string;
  /** Stable identity used for dedupe, e.g. `workspace:WORKSPACE.md`. */
  source: string;
}

export interface ContextAssemblyOptions {
  /**
   * Runtime that will consume the assembled context. `builtin` is the only
   * runtime that gets `runtime`-kind sections: Claude / Codex / DeepSeek load
   * their own `CLAUDE.md` / `AGENTS.md` and must never have them injected.
   */
  runtime: string;
  /** Total budget in `measure` units (characters by default). */
  budget: number;
  /** Defaults to character count; a tokenizer can be injected later. */
  measure?: (text: string) => number;
}

export type ContextOmissionReason =
  | 'empty'
  | 'duplicate'
  | 'runtime-self-managed'
  | 'section-budget'
  | 'budget';

export interface ContextOmission {
  source: string;
  kind: ContextSectionKind;
  reason: ContextOmissionReason;
}

export interface AssembledContext {
  /** Included sections, in final injection order. */
  sections: ContextSection[];
  /** Deterministic rendering of the included sections. */
  text: string;
  /** Everything that did not make it, with the reason (overrun stays visible). */
  omitted: ContextOmission[];
  /** True when a section was dropped for its own cap or the total budget. */
  overBudget: boolean;
  /** Measured size of the included sections. */
  used: number;
}
