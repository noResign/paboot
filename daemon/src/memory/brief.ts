import type { MemoryStore } from './store.js';
import type { MemoryClaim, MemoryScope } from './types.js';

export const DEFAULT_MEMORY_BRIEF_CHARS = 1200;
export const MAX_CLAIM_LINE_CHARS = 220;

const NOTE = '以上是本机长期记忆，可能过时；与用户当前说法冲突时，以当前为准。';

export interface MemoryBrief {
  markdown: string;
  charCount: number;
  usedClaimIds: string[];
  truncated: boolean;
  scope: MemoryScope;
}

export interface BuildBriefOptions {
  maxChars?: number;
  now?: number;
}

/**
 * Deterministic life brief (no LLM call). Claims are the only L1 data M0
 * produces, so the brief has「关于你」+「偏好」+ a staleness note.
 *
 * Authority order is `user_confirmed > derived`; the same predicate + object
 * appears once. `secret` is never injected (D35). The block is measured and
 * whole lines are dropped from the lowest-ranked claim until it fits (D32).
 */
export function buildLifeBrief(
  store: MemoryStore,
  scope: MemoryScope,
  options: BuildBriefOptions = {},
): MemoryBrief | null {
  const maxChars = options.maxChars ?? DEFAULT_MEMORY_BRIEF_CHARS;
  const now = options.now ?? Date.now();

  const current = store
    .listClaims(scope, 'active')
    .filter((claim) => claim.sensitivity !== 'secret')
    .filter((claim) => claim.validTo === null || claim.validTo > now);

  const unique = new Map<string, MemoryClaim>();
  for (const claim of current) {
    const key = `${claim.predicate}|${normalize(claim.objectText ?? claim.summary)}`;
    const existing = unique.get(key);
    if (!existing || rank(claim) > rank(existing)) unique.set(key, claim);
  }

  const ordered = [...unique.values()].sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  if (ordered.length === 0) return null;

  let included = ordered;
  let markdown = render(included);
  let truncated = false;
  while (markdown.length > maxChars && included.length > 1) {
    included = included.slice(0, -1);
    markdown = render(included);
    truncated = true;
  }

  return {
    markdown,
    charCount: markdown.length,
    usedClaimIds: included.map((claim) => claim.id),
    truncated,
    scope,
  };
}

export function renderClaimLine(claim: MemoryClaim): string {
  const summary = truncate(claim.summary.replace(/\s+/g, ' ').trim(), MAX_CLAIM_LINE_CHARS);
  const date = dateLabel(claim);
  const id = shortId(claim.id);
  return `- ${summary}${date} #claim_${id}`;
}

function render(claims: readonly MemoryClaim[]): string {
  const about = claims.filter((claim) => claim.kind !== 'preference');
  const preferences = claims.filter((claim) => claim.kind === 'preference');
  const blocks: string[] = [];
  if (about.length > 0) {
    blocks.push(`## 关于你\n${about.map(renderClaimLine).join('\n')}`);
  }
  if (preferences.length > 0) {
    blocks.push(`## 偏好\n${preferences.map(renderClaimLine).join('\n')}`);
  }
  blocks.push(`## 注意\n${NOTE}`);
  return blocks.join('\n\n');
}

function rank(claim: MemoryClaim): number {
  const authority = claim.authority === 'user_confirmed' ? 1000 : 0;
  return authority + claim.importance * 100 + claim.confidence * 10;
}

function dateLabel(claim: MemoryClaim): string {
  if (claim.validFrom === null) return '';
  const date = new Date(claim.validFrom);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  switch (claim.timePrecision) {
    case 'year':
      return `（${year} 起）`;
    case 'month':
      return `（${year}-${month} 起）`;
    case 'day':
    case 'exact':
      return `（${year}-${month}-${day} 起）`;
    default:
      return '';
  }
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 4);
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}
