/**
 * Deterministic completion matching for open loops (D38).
 *
 * The extraction model already reports `summary.completed`, so instead of
 * asking a second time "is this loop done?" we compare that text against loop
 * titles locally. Same philosophy as Tier-1 dedup: produce a candidate, never
 * auto-close — a wrong `done` silently loses work, a wrong candidate only costs
 * one line in a review list.
 *
 * Two details are load-bearing, both found by running this over a real
 * 170-loop / 40-summary corpus:
 *
 * 1. Compare per **sentence**, not against the whole summary. A summary is a
 *    long multi-topic narrative, so whole-text containment matched unrelated
 *    loops on generic bigrams (`实现` / `测试` / `路由`). Sentence scope dropped
 *    the false-positive rate sharply without losing the true matches.
 * 2. Reject sentences that say the work is still pending (`还剩` / `尚未` /
 *    `待办` …). Summaries restate open loops verbatim as "remaining work", and
 *    that text is the strongest false positive of all.
 *
 * Tokenisation mirrors `recall.ts`: CJK has no word boundaries, so 2-character
 * n-grams carry the signal; latin identifiers (file names, product names) stay
 * whole because they are the highest-signal part of a loop title.
 */

/** Minimum share of the loop title's tokens that a single sentence must cover. */
const MATCH_RATIO = 0.5;
/** One common bigram is noise; require at least two pieces of evidence. */
const MIN_SHARED_TOKENS = 2;
/** Sentences this short carry no topic. */
const MIN_SENTENCE_CHARS = 4;

/**
 * Split on whitespace and CJK punctuation only. ASCII `.` `:` `-` `/` stay
 * attached so identifiers like `recorder.test.ts` survive as one token.
 */
const TOKEN_SEPARATORS = /[\s，。！？、（）()「」“”"'`[\]{}<>|]+/;
const ASCII_PUNCTUATION = /[.,;:!?]/g;
const LATIN_TOKEN = /^[a-z0-9_./:-]+$/;

/** Sentence boundaries inside a one-line summary. */
const SENTENCE_SEPARATORS = /[。；;\n•·]+/;

/**
 * Language that marks work as *not* finished. Matched per sentence, so
 * "完成 X。" and "还剩 Y" are judged separately.
 */
const PENDING_SENTENCE =
  /(还剩|尚未|未完成|还没|待办|待确认|等待|待定|下一步|后续|TODO|TBD|not yet|remaining)/i;

export function matchTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const run of text.toLowerCase().split(TOKEN_SEPARATORS)) {
    if (run === '') continue;
    if (LATIN_TOKEN.test(run)) {
      if (run.length >= 3) tokens.add(run);
      continue;
    }
    const chars = Array.from(run.replace(ASCII_PUNCTUATION, ''));
    for (let index = 0; index + 2 <= chars.length; index += 1) {
      tokens.add(chars.slice(index, index + 2).join(''));
    }
  }
  return tokens;
}

export interface CompletionMatch {
  /** Share of the loop title's tokens covered by the best sentence. */
  score: number;
  /** The sentence that produced the score (for audit / debugging). */
  sentence: string;
}

/**
 * Pre-tokenised `completed` text. The worker checks one summary against every
 * open loop in the scope, so tokenising the summary once per batch instead of
 * once per loop keeps this cheap on large backlog scopes.
 */
export function createCompletionMatcher(completed: string): (loopTitle: string) => CompletionMatch {
  const sentences = completed
    .split(SENTENCE_SEPARATORS)
    .map((raw) => raw.trim())
    .filter((sentence) => Array.from(sentence).length >= MIN_SENTENCE_CHARS)
    .filter((sentence) => !PENDING_SENTENCE.test(sentence))
    .map((sentence) => ({ sentence, tokens: matchTokens(sentence) }));

  return (loopTitle: string): CompletionMatch => {
    const title = matchTokens(loopTitle);
    if (title.size === 0) return { score: 0, sentence: '' };
    let best: CompletionMatch = { score: 0, sentence: '' };
    for (const candidate of sentences) {
      let shared = 0;
      for (const token of title) {
        if (candidate.tokens.has(token)) shared += 1;
      }
      if (shared < MIN_SHARED_TOKENS) continue;
      const score = shared / title.size;
      if (score > best.score) best = { score, sentence: candidate.sentence };
    }
    return best;
  };
}

/** Best sentence-level coverage of `loopTitle` by `completed`. */
export function bestCompletionMatch(completed: string, loopTitle: string): CompletionMatch {
  return createCompletionMatcher(completed)(loopTitle);
}

export function completionScore(completed: string, loopTitle: string): number {
  return bestCompletionMatch(completed, loopTitle).score;
}

export function looksCompleted(completed: string, loopTitle: string): boolean {
  if (completed.trim() === '') return false;
  return completionScore(completed, loopTitle) >= MATCH_RATIO;
}

export function isCompletionMatch(match: CompletionMatch): boolean {
  return match.score >= MATCH_RATIO;
}
