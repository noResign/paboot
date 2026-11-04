import {
  CONTEXT_KIND_ORDER,
  type AssembledContext,
  type ContextAssemblyOptions,
  type ContextOmission,
  type ContextSection,
  type ContextSectionKind,
} from './types.js';

const KIND_INDEX = new Map<ContextSectionKind, number>(
  CONTEXT_KIND_ORDER.map((kind, index) => [kind, index]),
);

/** `builtin` is the only runtime whose own docs live in the assembled context. */
const RUNTIME_WITH_OWN_CONTEXT = 'builtin';

/**
 * Merge provider sections into one deterministic context block.
 *
 * Order: `runtime` → `workspace` → `end` → `requirements` → `memory` → `task`;
 * inside a kind, priority desc then source asc. Runtime-kind sections are
 * dropped for every non-builtin runtime: Claude / Codex / DeepSeek read their
 * own CLAUDE.md / AGENTS.md, so injecting them here would duplicate them.
 *
 * Budget is measured in characters by default (D32) and applied as whole-section
 * drops from the tail of the order (lowest priority first), never as a cut
 * through a section. Provider caps (`tokenBudget`) are checked first. Anything
 * dropped is returned in `omitted`, so callers can surface "context truncated".
 */
export function assembleContext(
  sections: readonly ContextSection[],
  options: ContextAssemblyOptions,
): AssembledContext {
  const measure = options.measure ?? ((text: string) => text.length);
  const omitted: ContextOmission[] = [];

  // 1) Empty sections never reach the order.
  const candidates: ContextSection[] = [];
  for (const section of sections) {
    if (section.content.trim().length === 0) {
      omitted.push({ source: section.source, kind: section.kind, reason: 'empty' });
    } else {
      candidates.push(section);
    }
  }

  // 2) Runtime-owned sections belong to builtin only. External runtimes load
  //    their own docs; the assembler must not inject them even if a provider
  //    accidentally emitted one.
  const withRuntime = options.runtime === RUNTIME_WITH_OWN_CONTEXT;
  const eligible: ContextSection[] = [];
  for (const section of candidates) {
    if (!withRuntime && section.kind === 'runtime') {
      omitted.push({ source: section.source, kind: section.kind, reason: 'runtime-self-managed' });
    } else {
      eligible.push(section);
    }
  }

  // 3) Fixed kind order, then priority desc, then source asc (stable output).
  eligible.sort(compareSections);

  // 4) One section per source; the highest-ranked occurrence wins.
  const seen = new Set<string>();
  const unique: ContextSection[] = [];
  for (const section of eligible) {
    if (seen.has(section.source)) {
      omitted.push({ source: section.source, kind: section.kind, reason: 'duplicate' });
      continue;
    }
    seen.add(section.source);
    unique.push(section);
  }

  // 5) Per-provider caps first, then the total budget from the tail (lowest
  //    priority / last kind) until it fits. Whole-section drops only.
  const included: ContextSection[] = [];
  for (const section of unique) {
    if (section.tokenBudget !== undefined && measure(section.content) > section.tokenBudget) {
      omitted.push({ source: section.source, kind: section.kind, reason: 'section-budget' });
      continue;
    }
    included.push(section);
  }

  let used = included.reduce((sum, section) => sum + measure(section.content), 0);
  let overBudget = omitted.some((entry) => entry.reason === 'section-budget');
  while (used > options.budget && included.length > 0) {
    const dropped = included.pop() as ContextSection;
    used -= measure(dropped.content);
    overBudget = true;
    omitted.push({ source: dropped.source, kind: dropped.kind, reason: 'budget' });
  }

  // 6) Stable rendering; the actual injection wrapper is runtime-specific (S1).
  const text = included.map((section) => section.content).join('\n\n');

  omitted.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  return { sections: included, text, omitted, overBudget, used };
}

function compareSections(a: ContextSection, b: ContextSection): number {
  const kind = (KIND_INDEX.get(a.kind) ?? Number.MAX_SAFE_INTEGER) -
    (KIND_INDEX.get(b.kind) ?? Number.MAX_SAFE_INTEGER);
  if (kind !== 0) return kind;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}
