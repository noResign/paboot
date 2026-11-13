import { claimAllowed, type MemoryReadPolicy, type ReadScope } from './read-policy.js';
import type { MemoryStore } from './store.js';
import type { MemoryClaim, MemoryScope } from './types.js';

export const DEFAULT_MEMORY_BRIEF_CHARS = 1200;
export const MAX_CLAIM_LINE_CHARS = 220;

/**
 * Plan-shaped predicates get their own block (D37). `focus` is single-valued
 * (D36) and is the current main line; `plan` / `goal` accumulate across
 * sessions, so without convergence the brief shows stale, mutually
 * contradictory roadmaps as if they were all still planned.
 */
const PLAN_PREDICATES = new Set(['focus', 'plan', 'goal']);
const FOCUS_PREDICATE = 'focus';
/** Besides the single `focus` line, keep at most this many other plans. */
const MAX_PLAN_LINES = 2;
/** An unreinforced plan older than this is treated as decayed, not current. */
const PLAN_STALE_MS = 14 * 86_400_000;

/**
 * Feedback window (D38). Operator feedback was stored but never read by the
 * selector, so `wrong` / `stale` changed nothing. 30 days keeps a correction
 * effective long enough to matter without pinning a claim forever.
 */
const FEEDBACK_WINDOW_MS = 30 * 86_400_000;
const FEEDBACK_PENALTY = { stale: 300, not_relevant: 150 } as const;
const FEEDBACK_HELPFUL_BONUS = 10;
const FEEDBACK_HELPFUL_CAP = 50;

const NOTE =
  '以上是本机长期记忆，可能过时；与用户当前说法冲突时，以当前为准。' +
  '「当前计划」只列最近确定的几条，更早的计划可用 search_memory 查到。';

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
  /**
   * Injection defaults to normal-only for dev; the API brief may include the
   * workspace's own private claims. Cross-workspace private is always excluded
   * by the read policy, not by this flag.
   */
  includePrivate?: boolean;
  /** Scope reported to callers; defaults to the policy's workspace scope. */
  scope?: MemoryScope;
  /**
   * D39: drop claims whose evidence comes only from this session. Run-time
   * injection passes the current session so the brief does not echo what was
   * just extracted out of the transcript the runtime already holds. The manual
   * `/api/memory/brief` call omits it — the user wants to see everything there.
   */
  excludeSessionId?: string;
}

/**
 * Deterministic brief over every scope the caller may read. Dev sees only its
 * own workspace; life additionally sees `user` (profile-filtered) and readable
 * dev workspaces. Claims are deduped by predicate + object and ranked
 * `user_confirmed > derived`; `secret` never appears (D35). Whole lines are
 * dropped from the lowest-ranked claim until the block fits (D32).
 */
export function buildMemoryBrief(
  store: MemoryStore,
  policy: MemoryReadPolicy,
  options: BuildBriefOptions = {},
): MemoryBrief | null {
  const maxChars = options.maxChars ?? DEFAULT_MEMORY_BRIEF_CHARS;
  const now = options.now ?? Date.now();
  const includePrivate = options.includePrivate ?? true;

  const current: MemoryClaim[] = [];
  for (const readScope of policy.scopes) {
    for (const claim of store.listClaims(readScope.scope, 'active')) {
      if (!claimAllowed(claim, policy)) continue;
      if (!includePrivate && claim.sensitivity !== 'normal') continue;
      if (claim.validTo !== null && claim.validTo <= now) continue;
      current.push(claim);
    }
  }

  // D38: `wrong` is an explicit "this is not true" — keep it out of injection
  // entirely rather than merely ranking it lower. `stale` / `not_relevant`
  // only down-weight, because they say "not now", not "false".
  const feedback = store.listFeedbackCounts(
    current.map((claim) => claim.id),
    now - FEEDBACK_WINDOW_MS,
  );
  const usable = current.filter((claim) => (feedback.get(claim.id)?.['wrong'] ?? 0) === 0);

  // D39: claims distilled out of this very session are already in the runtime's
  // transcript, so injecting them again only spends budget that cross-session
  // knowledge needs. A claim reinforced by any earlier session survives.
  const fromThisSession = options.excludeSessionId
    ? store.claimsOnlyFromSession(
        usable.map((claim) => claim.id),
        options.excludeSessionId,
      )
    : new Set<string>();

  const unique = new Map<string, MemoryClaim>();
  for (const claim of usable) {
    if (fromThisSession.has(claim.id)) continue;
    const key = `${claim.predicate}|${normalize(claim.objectText ?? claim.summary)}`;
    const existing = unique.get(key);
    if (
      !existing ||
      rank(claim, now, feedback.get(claim.id)) >
        rank(existing, now, feedback.get(existing.id))
    ) {
      unique.set(key, claim);
    }
  }

  // D37: plan convergence happens before ranking and before the budget, so a
  // stale roadmap cannot consume the character budget or evict current facts.
  // Converged-out plans stay in the store and remain searchable.
  const { plans, rest } = convergePlans([...unique.values()], now);
  const ordered = [...plans, ...rest].sort(
    (a, b) =>
      rank(b, now, feedback.get(b.id)) - rank(a, now, feedback.get(a.id)) ||
      a.id.localeCompare(b.id),
  );
  if (ordered.length === 0) return null;

  // D34: the newest 25% by wall-clock are protected from budget trimming so a
  // heavily reinforced old claim cannot evict the current facts.
  const newest = [...ordered]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.ceil(ordered.length * 0.25)))
    .map((claim) => claim.id);
  const protectedIds = new Set(newest);

  let included = ordered;
  let markdown = render(included);
  let truncated = false;
  while (markdown.length > maxChars && included.length > 1) {
    let dropAt = -1;
    for (let index = included.length - 1; index >= 0; index -= 1) {
      if (!protectedIds.has(included[index]!.id)) {
        dropAt = index;
        break;
      }
    }
    if (dropAt < 0) break;
    included = [...included.slice(0, dropAt), ...included.slice(dropAt + 1)];
    markdown = render(included);
    truncated = true;
  }

  return {
    markdown,
    charCount: markdown.length,
    usedClaimIds: included.map((claim) => claim.id),
    truncated,
    scope: options.scope ?? defaultScope(policy.scopes),
  };
}

/** Single-scope compatibility wrapper (M0 tests / callers). */
export function buildLifeBrief(
  store: MemoryStore,
  scope: MemoryScope,
  options: BuildBriefOptions = {},
): MemoryBrief | null {
  const readScope: ReadScope = { scope, includePrivate: true };
  return buildMemoryBrief(
    store,
    {
      scopes: [readScope],
      profileMode: scope === 'user' ? 'full' : 'off',
      includesUser: scope === 'user',
    },
    { ...options, scope },
  );
}

function defaultScope(scopes: readonly ReadScope[]): MemoryScope {
  return scopes.find((item) => item.scope.startsWith('workspace:'))?.scope ?? scopes[0]!.scope;
}

export function renderClaimLine(claim: MemoryClaim): string {
  const summary = truncate(claim.summary.replace(/\s+/g, ' ').trim(), MAX_CLAIM_LINE_CHARS);
  const date = dateLabel(claim);
  const id = shortId(claim.id);
  const marker = claim.predicate === FOCUS_PREDICATE ? '[当前主线] ' : '';
  return `- ${marker}${summary}${date} #claim_${id}`;
}

/**
 * Converge plan claims (D37). `focus` is single-valued, so only the newest one
 * is shown. `plan` / `goal` are legitimately multi-valued, so the newest few
 * survive — but only while they are fresh or were reinforced.
 */
function convergePlans(
  claims: readonly MemoryClaim[],
  now: number,
): { plans: MemoryClaim[]; rest: MemoryClaim[] } {
  const plans: MemoryClaim[] = [];
  const rest: MemoryClaim[] = [];
  for (const claim of claims) {
    (PLAN_PREDICATES.has(claim.predicate) ? plans : rest).push(claim);
  }
  // Tie-break by recency only: plan selection must stay feedback-independent so
  // a `stale` mark cannot resurrect an older roadmap into the current block.
  const byRecency = (a: MemoryClaim, b: MemoryClaim): number => recency(b) - recency(a);

  const focus = plans
    .filter((claim) => claim.predicate === FOCUS_PREDICATE)
    .sort(byRecency)
    .slice(0, 1);
  const others = plans
    .filter((claim) => claim.predicate !== FOCUS_PREDICATE)
    .filter((claim) => now - recency(claim) <= PLAN_STALE_MS || claim.reinforcementDates.length > 0)
    .sort(byRecency)
    .slice(0, MAX_PLAN_LINES);

  return { plans: [...focus, ...others], rest };
}

/** Wall-clock the decision belongs to: `validFrom` when known, else capture. */
function recency(claim: MemoryClaim): number {
  return claim.validFrom ?? claim.createdAt;
}

function render(claims: readonly MemoryClaim[]): string {
  const about = claims.filter((claim) => claim.kind !== 'preference' && !PLAN_PREDICATES.has(claim.predicate));
  const plans = claims.filter((claim) => PLAN_PREDICATES.has(claim.predicate));
  const preferences = claims.filter(
    (claim) => claim.kind === 'preference' && !PLAN_PREDICATES.has(claim.predicate),
  );
  const blocks: string[] = [];
  if (about.length > 0) {
    blocks.push(`## 关于你\n${about.map(renderClaimLine).join('\n')}`);
  }
  if (plans.length > 0) {
    blocks.push(`## 当前计划\n${plans.map(renderClaimLine).join('\n')}`);
  }
  if (preferences.length > 0) {
    blocks.push(`## 偏好\n${preferences.map(renderClaimLine).join('\n')}`);
  }
  blocks.push(`## 注意\n${NOTE}`);
  return blocks.join('\n\n');
}

/**
 * D34 ACT-R selection. α = 0 for now: pure recency, reinforcement stored only.
 * D38 folds operator feedback in as a bounded adjustment — never above the
 * `user_confirmed` authority bonus, so a confirmed claim still wins.
 */
function rank(
  claim: MemoryClaim,
  now: number,
  feedback: Record<string, number> | undefined,
): number {
  const authority = claim.authority === 'user_confirmed' ? 1000 : 0;
  const ageDays = Math.max(1, (now - claim.createdAt) / 86_400_000);
  const actr = Math.log(1 + 1 / Math.sqrt(ageDays));
  return (
    authority +
    (claim.importance * 0.6 + actr * 0.4) * 100 +
    claim.confidence * 10 +
    feedbackAdjustment(feedback)
  );
}

function feedbackAdjustment(feedback: Record<string, number> | undefined): number {
  if (!feedback) return 0;
  const helpful = Math.min((feedback['helpful'] ?? 0) * FEEDBACK_HELPFUL_BONUS, FEEDBACK_HELPFUL_CAP);
  const stale = Math.min((feedback['stale'] ?? 0) * FEEDBACK_PENALTY.stale, FEEDBACK_PENALTY.stale * 2);
  const notRelevant = Math.min(
    (feedback['not_relevant'] ?? 0) * FEEDBACK_PENALTY.not_relevant,
    FEEDBACK_PENALTY.not_relevant * 2,
  );
  return helpful - stale - notRelevant;
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
