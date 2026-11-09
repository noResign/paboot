/**
 * Per-turn recall triggers (read-pipeline §6.2, M1 heuristic).
 *
 * Entity matching arrives with the M2 entity graph; M1 only reacts to explicit
 * memory cues. Retrieval still goes through the normal read policy, so this
 * function decides *whether* to look, never *what* is visible.
 */
const RECALL_CUES = [
  /上次/,
  /之前/,
  /以前/,
  /记得/,
  /我说过/,
  /还记得/,
  /前面说/,
  /继续/,
  /接着/,
  /接下来/,
  /last time/i,
  /remember/i,
  /previously/i,
  /continue/i,
];

const CUE_WORDS =
  /(上次|之前|以前|记得|我说过|还记得|前面说|说过的|继续|接着|接下来|是什么|怎么样|哪一个?|哪些|吗|呢|last time|remember|previously|continue)/gi;

export function shouldRecall(prompt: string): boolean {
  return RECALL_CUES.some((pattern) => pattern.test(prompt));
}

/**
 * Chinese has no whitespace, so a raw sentence rarely matches anything under
 * FTS/LIKE substring search. Build a small OR query from 2-4 character n-grams
 * after stripping the cue words. Latin words are kept as-is.
 */
export function recallQuery(prompt: string, maxTerms = 16): string {
  const stripped = prompt.replace(CUE_WORDS, ' ').trim();
  const terms = new Set<string>();
  for (const word of stripped.split(/[\s，。！？、,.!?;:：；（）()「」“”"'`]+/)) {
    if (!word) continue;
    if (/^[A-Za-z0-9_./:-]+$/.test(word)) {
      if (word.length >= 3) terms.add(word);
      continue;
    }
    const chars = Array.from(word);
    for (let size = 4; size >= 2; size -= 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        terms.add(chars.slice(index, index + size).join(''));
        if (terms.size >= maxTerms) break;
      }
      if (terms.size >= maxTerms) break;
    }
    if (terms.size >= maxTerms) break;
  }
  return [...terms].join(' ');
}
