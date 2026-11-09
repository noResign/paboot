import { createHash } from 'node:crypto';
import type { LlmProvider } from '../llm/types.js';
import type {
  ClaimKind,
  MemorySource,
  ObservationType,
  Sensitivity,
} from './types.js';

export const MEMORY_PREDICATES = [
  'lives_in',
  'works_at',
  'likes',
  'dislikes',
  'has_pet',
  'relation',
  'name',
  'birthday',
  'prefers',
  'health',
  'schedule',
  'plan',
  'habit',
  'goal',
] as const;

export type MemoryPredicate = (typeof MEMORY_PREDICATES)[number];
export type TimePrecision = 'exact' | 'day' | 'month' | 'year' | 'unknown';

export interface ExtractedEvidence {
  sourceId: string;
  quote: string;
}

export interface ExtractedClaim {
  predicate: MemoryPredicate;
  objectText: string;
  kind: ClaimKind;
  summary: string;
  validFrom: number | null;
  timePrecision: TimePrecision;
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  evidence: ExtractedEvidence[];
}

export interface ExtractedObservation {
  kind: 'tool' | 'turn';
  type: ObservationType;
  title: string;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  sensitivity: Sensitivity;
}

export interface ExtractedSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
  notes: string | null;
}

export interface ExtractionResult {
  claims: ExtractedClaim[];
  observations: ExtractedObservation[];
  summary: ExtractedSummary | null;
}

export type ExtractionErrorCode = 'invalid_json' | 'invalid_schema' | 'provider_unavailable';

export class MemoryExtractionError extends Error {
  constructor(
    message: string,
    readonly code: ExtractionErrorCode,
  ) {
    super(message);
    this.name = 'MemoryExtractionError';
  }
}

const CLAIM_KINDS = new Set<ClaimKind>(['fact', 'preference', 'relation', 'profile']);
const SENSITIVITIES = new Set<Sensitivity>(['normal', 'private', 'secret']);
const OBSERVATION_TYPES = new Set<ObservationType>([
  'bugfix',
  'feature',
  'refactor',
  'change',
  'discovery',
  'decision',
  'security_alert',
  'security_note',
  'sensitive',
]);
const TIME_PRECISIONS = new Set<TimePrecision>(['exact', 'day', 'month', 'year', 'unknown']);
const PREDICATES = new Set<string>(MEMORY_PREDICATES);

export function extractionSystemPrompt(): string {
  return [
    '你是 paboot 的长期记忆抽取器。只输出一个 JSON 对象，不要 markdown、不要解释。',
    '从用户的生活会话里抽取值得长期记住的事实、偏好、关系、计划和习惯。',
    '规则：',
    '1. 每条 claim 必须有 evidence；quote 必须逐字来自对应 source 的 content。',
    '2. 不抽取闲聊、一次性信息、通用知识或 agent 自己的推测。',
    '3. 密码、密钥、验证码等不要输出；健康 / 财务 / 证件内容 sensitivity 用 private。',
    `4. predicate 只能取：${MEMORY_PREDICATES.join(', ')}。`,
    '5. kind 只能取：fact | preference | relation | profile。',
    '6. summary 是一句简洁中文，供 brief 和「关于你」展示。',
    '7. 没有值得长期记录的内容时输出 {"claims":[]}。',
    '8. 标记为 context 的消息只用于理解指代和背景；不要为 context 单独创建 claim，',
    '   evidence 的 sourceId 只能引用当前要抽取的 source。',
    '9. 可选输出 observations：把本批工作压缩成 0..N 条；kind 只能 tool|turn；',
    '   type 只能 bugfix|feature|refactor|change|discovery|decision|security_alert|security_note|sensitive；',
    '   每条含 title、subtitle、facts（字符串数组）、narrative、concepts（字符串数组）。',
    '   没有可记的工作内容就省略或输出空数组。',
    '10. 可选输出 summary：{request, investigated, learned, completed, nextSteps, notes}；',
    '    nextSteps 写下一步计划（没有就空字符串）。',
    '输出格式：',
    '{"claims":[{"predicate":"lives_in","object":"上海","kind":"fact",',
    '"summary":"住在上海","validFrom":"2026-09","timePrecision":"month",',
    '"confidence":0.9,"importance":0.8,"sensitivity":"normal",',
    '"evidence":[{"sourceId":"<source id>","quote":"我上个月搬到上海了"}]}],',
    '"observations":[{"kind":"turn","type":"bugfix","title":"修复登录页报错",',
    '"subtitle":"更新 src/login.ts","facts":["登录页报错","已修复"],"narrative":"……",',
    '"concepts":["what-changed"]}],',
    '"summary":{"request":"……","investigated":"","learned":"","completed":"……",',
    '"nextSteps":"","notes":null}}',
  ].join('\n');
}

export function buildExtractionPrompt(
  sources: readonly MemorySource[],
  contextSources: readonly MemorySource[] = [],
): string {
  const blocks = sources.map(
    (source) =>
      `[source ${source.id} | ${new Date(source.occurredAt).toISOString()} | kind=${source.kind}]\n` +
      `${source.content}\n[/source]`,
  );
  const context = contextSources.map(
    (source) =>
      `[context ${source.id} | ${new Date(source.occurredAt).toISOString()}]\n` +
      `${source.content}\n[/context]`,
  );
  const contextBlock =
    context.length > 0
      ? `以下上下文已经整理过，仅用于理解当前消息：\n\n${context.join('\n\n')}\n\n`
      : '';
  return `${contextBlock}请从下面的消息中抽取记忆：\n\n${blocks.join('\n\n')}`;
}

/**
 * Strictly validate one model response. Unknown predicates, unverifiable
 * quotes and `secret` claims are dropped instead of being persisted; a parse
 * failure throws so the worker can retry once.
 */
export function parseExtraction(
  raw: string,
  sources: readonly MemorySource[],
): ExtractedClaim[] {
  return parseExtractionResult(raw, sources).claims;
}

/** Parse claims + optional observations / session summary from one response. */
export function parseExtractionResult(
  raw: string,
  sources: readonly MemorySource[],
): ExtractionResult {
  const document = parseJsonDocument(raw);
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new MemoryExtractionError('extraction response is not an object', 'invalid_schema');
  }
  const record = document as Record<string, unknown>;
  if (record['skip'] === true) {
    return { claims: [], observations: [], summary: null };
  }
  const rawClaims = record['claims'];
  if (rawClaims !== undefined && !Array.isArray(rawClaims)) {
    throw new MemoryExtractionError('claims must be an array', 'invalid_schema');
  }

  const byId = new Map(sources.map((source) => [source.id, source]));
  const claims: ExtractedClaim[] = [];
  for (const item of arrayValue(rawClaims)) {
    const claim = parseClaim(item, byId);
    if (claim) claims.push(claim);
  }
  const observations: ExtractedObservation[] = [];
  for (const item of arrayValue(record['observations'])) {
    const observation = parseObservation(item);
    if (observation) observations.push(observation);
  }
  return {
    claims,
    observations,
    summary: parseSummary(record['summary']),
  };
}

export async function extractClaims(input: {
  provider: LlmProvider;
  providerId: string;
  model: string;
  sources: readonly MemorySource[];
  /** Already-processed sources used only for pronoun/context resolution. */
  contextSources?: readonly MemorySource[];
  signal: AbortSignal;
}): Promise<ExtractedClaim[]> {
  return (await extractMemory(input)).claims;
}

/** One call produces claims, observations and the run summary. */
export async function extractMemory(input: {
  provider: LlmProvider;
  providerId: string;
  model: string;
  sources: readonly MemorySource[];
  contextSources?: readonly MemorySource[];
  signal: AbortSignal;
}): Promise<ExtractionResult> {
  const completion = await input.provider.complete({
    provider: input.providerId,
    model: input.model,
    system: extractionSystemPrompt(),
    messages: [
      { role: 'user', content: buildExtractionPrompt(input.sources, input.contextSources) },
    ],
    tools: [],
    maxTokens: 2000,
    temperature: 0,
    signal: input.signal,
  });
  if (completion.finishReason === 'unavailable') {
    throw new MemoryExtractionError('memory provider is unavailable', 'provider_unavailable');
  }
  return parseExtractionResult(completion.text, input.sources);
}

/** Stable Tier-0 key; subject is the user in M0 (no entity graph yet). */
export function claimDedupKey(predicate: string, objectText: string): string {
  return createHash('sha256')
    .update(`${predicate}|${normalizeForMatch(objectText)}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function parseClaim(
  item: unknown,
  sources: Map<string, MemorySource>,
): ExtractedClaim | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;

  const predicate = stringValue(record['predicate']);
  if (!predicate || !PREDICATES.has(predicate)) return null;

  const objectText = stringValue(record['object']);
  if (!objectText) return null;

  const kind = stringValue(record['kind']) as ClaimKind | null;
  if (!kind || !CLAIM_KINDS.has(kind)) return null;

  const summary = stringValue(record['summary']) ?? objectText;
  const sensitivity = (stringValue(record['sensitivity']) ?? 'normal') as Sensitivity;
  if (!SENSITIVITIES.has(sensitivity) || sensitivity === 'secret') return null;

  const evidence = parseEvidence(record['evidence'], sources);
  if (evidence.length === 0) return null;

  const confidence = clamp(numberValue(record['confidence']) ?? 0.6, 0, 1);
  const importance = clamp(numberValue(record['importance']) ?? 0.5, 0, 1);
  const time = parseTime(record['validFrom'], record['timePrecision']);

  return {
    predicate: predicate as MemoryPredicate,
    objectText,
    kind,
    summary,
    validFrom: time.validFrom,
    timePrecision: time.timePrecision,
    confidence,
    importance,
    sensitivity,
    evidence,
  };
}

function parseObservation(item: unknown): ExtractedObservation | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const kind = stringValue(record['kind']);
  if (kind !== 'tool' && kind !== 'turn') return null;
  const type = stringValue(record['type']) as ObservationType | null;
  if (!type || !OBSERVATION_TYPES.has(type)) return null;
  const title = stringValue(record['title']);
  if (!title) return null;
  const sensitivity = (stringValue(record['sensitivity']) ?? 'normal') as Sensitivity;
  if (!SENSITIVITIES.has(sensitivity) || sensitivity === 'secret') return null;
  return {
    kind,
    type,
    title,
    subtitle: stringValue(record['subtitle']),
    facts: stringArray(record['facts']),
    narrative: stringValue(record['narrative']),
    concepts: stringArray(record['concepts']),
    sensitivity,
  };
}

function parseSummary(raw: unknown): ExtractedSummary | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const summary: ExtractedSummary = {
    request: stringValue(record['request']) ?? '',
    investigated: stringValue(record['investigated']) ?? '',
    learned: stringValue(record['learned']) ?? '',
    completed: stringValue(record['completed']) ?? '',
    nextSteps: stringValue(record['nextSteps']) ?? '',
    notes: stringValue(record['notes']),
  };
  return Object.values(summary).some((value) => value !== null && value !== '') ? summary : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '');
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseEvidence(
  raw: unknown,
  sources: Map<string, MemorySource>,
): ExtractedEvidence[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEvidence[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const sourceId = stringValue(record['sourceId']);
    const quote = stringValue(record['quote']);
    if (!sourceId || !quote) continue;
    const source = sources.get(sourceId);
    if (!source) continue;
    if (!normalizeForMatch(source.content).includes(normalizeForMatch(quote))) continue;
    out.push({ sourceId, quote });
  }
  return out;
}

function parseJsonDocument(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new MemoryExtractionError('extraction response has no JSON object', 'invalid_json');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new MemoryExtractionError('extraction response is not valid JSON', 'invalid_json');
  }
}

function parseTime(
  raw: unknown,
  precisionRaw: unknown,
): { validFrom: number | null; timePrecision: TimePrecision } {
  const value = stringValue(raw);
  const requested = stringValue(precisionRaw) as TimePrecision | null;
  const timePrecision =
    requested && TIME_PRECISIONS.has(requested) ? requested : inferPrecision(value);
  if (!value) return { validFrom: null, timePrecision: 'unknown' };

  const normalized = /^\d{4}$/.test(value)
    ? `${value}-01-01`
    : /^\d{4}-\d{2}$/.test(value)
      ? `${value}-01`
      : value;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return { validFrom: null, timePrecision: 'unknown' };
  return { validFrom: parsed, timePrecision };
}

function inferPrecision(value: string | null): TimePrecision {
  if (!value) return 'unknown';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'exact';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
  if (/^\d{4}-\d{2}$/.test(value)) return 'month';
  if (/^\d{4}$/.test(value)) return 'year';
  return 'unknown';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}
