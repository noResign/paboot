import type { LlmMessage, ToolSchema } from '../../llm/types.js';

/**
 * Conservative density heuristic. CJK text is usually ~0.6-1 token per
 * character, while Latin/code averages ~4 characters per token; pricing both
 * with one ratio underestimates Chinese prompts badly.
 *
 * Real provider usage calibrates this at runtime (see {@link TokenCalibrator}),
 * so the raw estimate only needs to be stable and roughly right.
 */
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let units = 0;
  for (const char of text) {
    units += isWideCodePoint(char.codePointAt(0) ?? 0) ? 1 : 1 / CHARS_PER_TOKEN;
  }
  return Math.max(1, Math.ceil(units));
}

/** CJK, Hangul, Kana, fullwidth punctuation and emoji are roughly one token each. */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export interface RequestEstimate {
  tokens: number;
  hasImages: boolean;
}

/**
 * Price one complete model request for calibration: system text, neutral
 * messages (text, tool calls, tool results) and tool schemas. Images are
 * flagged because their provider-side cost is route-specific; callers skip
 * calibration on those requests.
 */
export function estimateRequestTokens(input: {
  system: string;
  messages: readonly LlmMessage[];
  tools: readonly ToolSchema[];
  measure?: (text: string) => number;
}): RequestEstimate {
  const measure = input.measure ?? estimateTokens;
  let tokens = 0;
  let hasImages = false;

  if (input.system.length > 0) tokens += measure(input.system);
  for (const message of input.messages) {
    tokens += ROLE_OVERHEAD;
    if (typeof message.content === 'string') {
      tokens += measure(message.content);
      continue;
    }
    for (const block of message.content) {
      tokens += BLOCK_OVERHEAD;
      switch (block.type) {
        case 'text':
          tokens += measure(block.text);
          break;
        case 'image':
          hasImages = true;
          break;
        case 'tool_use':
          tokens += measure(block.id) + measure(block.name) + measure(JSON.stringify(block.input ?? {}));
          break;
        case 'tool_result':
          tokens += measure(block.content);
          break;
      }
    }
  }
  if (input.tools.length > 0) tokens += measure(JSON.stringify(input.tools));

  return { tokens: Math.ceil(tokens), hasImages };
}

const CALIBRATION_EWMA = 0.25;
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;
const MIN_SAMPLE_TOKENS = 100;
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

/** Process-wide factor per `provider:model`; it survives runs but not restarts. */
const factorsByModel = new Map<string, number>();

/**
 * Turns raw density estimates into provider-token estimates. After every model
 * call the kernel feeds back the provider's real input size, and the factor
 * converges on that model's tokenizer/language mix. Requires no tokenizer
 * dependency and no configuration.
 */
export class TokenCalibrator {
  private factor: number;

  constructor(readonly modelKey: string) {
    this.factor = clamp(factorsByModel.get(modelKey) ?? 1, MIN_FACTOR, MAX_FACTOR);
  }

  get currentFactor(): number {
    return this.factor;
  }

  measure = (text: string): number => Math.ceil(estimateTokens(text) * this.factor);

  observe(actualInputTokens: number, estimate: RequestEstimate): void {
    if (estimate.hasImages) return;
    if (estimate.tokens < MIN_SAMPLE_TOKENS) return;
    if (!Number.isFinite(actualInputTokens) || actualInputTokens <= 0) return;
    const ratio = clamp(actualInputTokens / estimate.tokens, MIN_RATIO, MAX_RATIO);
    const next = clamp(
      this.factor * (1 - CALIBRATION_EWMA) + ratio * CALIBRATION_EWMA,
      MIN_FACTOR,
      MAX_FACTOR,
    );
    this.factor = next;
    factorsByModel.set(this.modelKey, next);
  }
}

export function createTokenCalibrator(modelKey: string): TokenCalibrator {
  return new TokenCalibrator(modelKey);
}

/** Test seam: forget every learned factor. */
export function resetTokenCalibration(): void {
  factorsByModel.clear();
}

export interface TruncateOptions {
  measure?: (text: string) => number;
  /** Fraction of the remaining budget kept at the start; the rest is the tail. */
  headRatio?: number;
  marker?: string;
}

const DEFAULT_TRUNCATE_MARKER = '\n\n[... truncated to fit the token budget ...]\n\n';

/**
 * Trim text to a token budget, keeping the head and tail. Used for oversized
 * project docs and tool results so both ends (setup + conclusion) survive.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  options: TruncateOptions = {},
): string {
  const measure = options.measure ?? estimateTokens;
  if (maxTokens <= 0) return '';
  if (measure(text) <= maxTokens) return text;

  const marker = options.marker ?? DEFAULT_TRUNCATE_MARKER;
  const markerTokens = measure(marker);
  if (maxTokens <= markerTokens) {
    const ratio = maxTokens / Math.max(1, markerTokens);
    return marker.slice(0, Math.max(1, Math.floor(marker.length * ratio)));
  }

  const remaining = maxTokens - markerTokens;
  const headRatio = clamp(options.headRatio ?? 0.75, 0, 1);
  const headBudget = Math.ceil(remaining * headRatio);
  const tailBudget = Math.max(0, remaining - headBudget);
  const chars = Array.from(text);
  const head = takePrefix(chars, headBudget, measure);
  const tail = tailBudget > 0 ? takeSuffix(chars, tailBudget, measure) : '';
  return `${head}${marker}${tail}`;
}

function takePrefix(
  chars: readonly string[],
  budget: number,
  measure: (text: string) => number,
): string {
  if (budget <= 0) return '';
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(chars.slice(0, mid).join('')) <= budget) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('');
}

function takeSuffix(
  chars: readonly string[],
  budget: number,
  measure: (text: string) => number,
): string {
  if (budget <= 0) return '';
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(chars.slice(chars.length - mid).join('')) <= budget) low = mid;
    else high = mid - 1;
  }
  return chars.slice(chars.length - low).join('');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
