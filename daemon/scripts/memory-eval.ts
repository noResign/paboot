#!/usr/bin/env node
/**
 * Memory quality evaluation harness.
 *
 * Two layers, both measured on what actually happens rather than on a model's
 * self-report:
 *   1. extraction — conversation fixtures → claims, through the real worker;
 *   2. injection  — those claims → the rendered brief/recall, with size and
 *      byte-stability (the proxy for prompt-cache churn).
 *
 * `--fake` runs built-in controls (positive / wrong object / secret /
 * determinism / label mutation) and must pass without any provider key. That is
 * how the harness proves it can tell good from bad.
 *
 * Samples stay out of the repo under docs/local/memory_eval/samples; this
 * script only knows the JSONL shape.
 *
 * Usage:
 *   pnpm eval:memory -- --fake
 *   pnpm eval:memory -- --live --samples ../../docs/local/memory_eval/samples
 *   pnpm eval:memory -- --live --samples <file.jsonl> --only s07 --dump-prompt
 *   pnpm eval:memory -- --live --samples <dir> --out ../../docs/local/memory_eval/reports/2026-11-19.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../src/app/context.js';
import { Db } from '../src/db/db.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';
import { buildMemoryBrief } from '../src/memory/brief.js';
import type { MemoryModelSelection } from '../src/memory/model.js';
import { resolveMemoryModel } from '../src/memory/model.js';
import type { MemoryReadPolicy } from '../src/memory/read-policy.js';
import { MemoryStore } from '../src/memory/store.js';
import type { MemoryScope } from '../src/memory/types.js';
import { MemoryWorker } from '../src/memory/worker.js';
import { memoryRecall } from '../src/runs/memory-recall.js';

// ---------------------------------------------------------------------------
// Sample shape

interface EvalClaim {
  predicate: string;
  object: string;
  kind?: string;
}

interface EvalSample {
  id: string;
  family?: 'dev' | 'life';
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
  expectClaims?: EvalClaim[];
  /** Claims whose appearance anywhere in the output is a failure. */
  forbidClaims?: EvalClaim[];
  /** Alternative wordings accepted as a hit, for hand-labelled ambiguity. */
  acceptableClaims?: EvalClaim[];
  /** A prompt that should trigger per-turn recall. */
  probe?: { prompt: string };
  notes?: string;
}

// ---------------------------------------------------------------------------
// Results

interface ScenarioResult {
  id: string;
  family: 'dev' | 'life';
  extraction: {
    expected: number;
    matched: number;
    forbiddenHits: number;
    extra: number;
    secretClaims: number;
    workerError: string | null;
    claims: Array<{
      predicate: string;
      object: string | null;
      summary: string;
      sensitivity: string;
    }>;
  };
  brief: {
    chars: number;
    matched: number;
    noise: number;
    forbiddenHits: number;
    stable: boolean;
    rendered: string | null;
  };
  recall: {
    triggered: boolean;
    chars: number;
    matched: number;
    forbiddenHits: number;
    rendered: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers

const WS_PREFIX = 'eval-';

function norm(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function claimKey(predicate: string, object: string | null): string {
  return `${predicate.trim()}::${norm(object ?? '')}`;
}

function expectedKeys(claims: readonly EvalClaim[] | undefined): Set<string> {
  return new Set((claims ?? []).map((claim) => claimKey(claim.predicate, claim.object)));
}

function acceptableKeys(sample: EvalSample): Set<string> {
  return new Set([
    ...expectedKeys(sample.expectClaims),
    ...expectedKeys(sample.acceptableClaims),
  ]);
}

/**
 * An accepted alternative can stand in for one expected claim, but never turns
 * one expected claim into two. Denominator stays `expectClaims.length`.
 */
function countHits(
  expected: Set<string>,
  acceptable: Set<string>,
  has: (key: string) => boolean,
): number {
  const direct = [...expected].filter((key) => has(key)).length;
  const spare = expected.size - direct;
  if (spare === 0) return direct;
  const alternatives = [...acceptable].filter((key) => !expected.has(key) && has(key)).length;
  return direct + Math.min(spare, alternatives);
}

function sourceIdOf(request: LlmRequest): string | null {
  const match = /\[source\s+([^\s|]+)\s+\|/.exec(request.system + '\n' + requestText(request));
  return match ? match[1]!.trim() : null;
}

function requestText(request: LlmRequest): string {
  return request.messages
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
}

function fakeProvider(id: string, respond: (request: LlmRequest) => string): LlmProvider {
  return {
    id,
    kind: 'openai',
    available: true,
    async *stream() {
      // Memory only calls complete().
    },
    async complete(request) {
      return { text: respond(request), toolCalls: [], finishReason: 'stop', usage: null };
    },
  };
}

function fakeModel(provider: LlmProvider): MemoryModelSelection {
  return {
    provider,
    providerId: provider.id,
    model: 'fake',
    modelId: `${provider.id}:fake`,
    providerConfig: { id: provider.id },
    modelConfig: { id: 'fake' },
  } as unknown as MemoryModelSelection;
}

function claimJson(input: {
  predicate: string;
  object: string;
  kind?: string;
  summary: string;
  quote: string;
  sourceId: string;
  sensitivity?: 'normal' | 'secret';
}): string {
  return JSON.stringify({
    claims: [
      {
        predicate: input.predicate,
        object: input.object,
        kind: input.kind ?? 'fact',
        summary: input.summary,
        confidence: 0.9,
        importance: 0.8,
        sensitivity: input.sensitivity ?? 'normal',
        evidence: [{ sourceId: input.sourceId, quote: input.quote }],
      },
    ],
  });
}

function emptyTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `paboot-${prefix}-`));
}

// ---------------------------------------------------------------------------
// One scenario: conversation → claims → brief/recall metrics

interface RunOptions {
  provider: LlmProvider;
  model: MemoryModelSelection;
  dumpPrompt: boolean;
}

async function runScenario(sample: EvalSample, options: RunOptions): Promise<ScenarioResult> {
  const sampleId = String(sample.id);
  const workspaceId = `${WS_PREFIX}${sampleId}`;
  const scope = `workspace:${workspaceId}` as MemoryScope;
  const family = sample.family ?? 'life';
  const memoryDir = emptyTemp('memory-eval');
  const workspaceDir = emptyTemp('memory-eval-ws');
  const store = new MemoryStore(memoryDir);
  const db = new Db(':memory:');

  try {
    const workspace = db.createWorkspace({
      id: workspaceId,
      name: `eval-${sampleId}`,
      path: workspaceDir,
      family,
    });
    db.putMemorySettings(workspace.id, {
      enabled: true,
      injectionEnabled: true,
      providerOverride: null,
    });
    const session = db.createSession({
      id: `s-${sampleId}`,
      runtime: 'claude',
      workspaceId: workspace.id,
      permissionMode: 'ask',
      cwd: workspace.path,
      title: sampleId,
    });

    // One run per user turn keeps the worker's turn grouping meaningful.
    let messageId = 0;
    let runIndex = 0;
    let currentRun = '';
    for (const message of sample.conversation) {
      if (message.role === 'user' || currentRun === '') {
        runIndex += 1;
        currentRun = `run-${runIndex}`;
      }
      messageId += 1;
      store.insertSource({
        scope,
        workspaceId,
        endId: null,
        kind: 'message',
        sourceTable: 'messages',
        sessionId: session.id,
        runId: currentRun,
        messageId,
        // Recent enough that rendered dates look like a live session.
        occurredAt: Date.now() - 7 * 86_400_000 + messageId,
        content: `${message.role}: ${message.content}`,
      });
    }

    const worker = new MemoryWorker({
      store,
      resolveModel: async () => options.model,
    });
    const workerResult = await worker.runOnce();
    const claims = store.listClaims(scope as `workspace:${string}`, 'active');
    const claimByKey = new Map<string, (typeof claims)[number]>();
    for (const claim of claims) {
      claimByKey.set(claimKey(claim.predicate, claim.objectText), claim);
    }

    const expected = expectedKeys(sample.expectClaims);
    const acceptable = acceptableKeys(sample);
    const forbidden = expectedKeys(sample.forbidClaims);
    const matchedExpected = [...expected].filter((key) => claimByKey.has(key));
    const matchedCount = countHits(expected, acceptable, (key) => claimByKey.has(key));
    const forbiddenClaims = [...forbidden]
      .map((key) => claimByKey.get(key))
      .filter((claim): claim is (typeof claims)[number] => claim !== undefined);

    const policy: MemoryReadPolicy = {
      scopes: [{ scope: scope as `workspace:${string}`, includePrivate: true }],
      profileMode: 'off',
      includesUser: false,
    };
    const brief = buildMemoryBrief(store, policy, { scope: scope as `workspace:${string}` });
    const briefAgain = buildMemoryBrief(store, policy, { scope: scope as `workspace:${string}` });
    const rendered = brief?.markdown ?? '';
    const usedIds = new Set(brief?.usedClaimIds ?? []);
    const usedClaims = claims.filter((claim) => usedIds.has(claim.id));
    const briefMatched = countHits(
      expected,
      acceptable,
      (key) => {
        const claim = claimByKey.get(key);
        return claim !== undefined && usedIds.has(claim.id);
      },
    );
    const briefNoise = usedClaims.filter(
      (claim) => !acceptable.has(claimKey(claim.predicate, claim.objectText)),
    ).length;
    const briefForbidden = forbiddenClaims.filter((claim) => usedIds.has(claim.id)).length;

    let recall: ScenarioResult['recall'] = null;
    if (sample.probe?.prompt) {
      // Probe from a *different* session: D39 drops claims whose evidence comes
      // only from the asking session, which is the real cross-session case.
      const probeSession = db.createSession({
        id: `s-${sampleId}-probe`,
        runtime: 'claude',
        workspaceId: workspace.id,
        permissionMode: 'ask',
        cwd: workspace.path,
        title: `${sampleId}-probe`,
      });
      const ctx = { db, memory: store, config: {} } as unknown as AppContext;
      const hit = memoryRecall(
        ctx,
        db.getSession(probeSession.id)!,
        db.getWorkspace(workspace.id)!,
        sample.probe.prompt,
      );
      const text = hit?.prefix ?? '';
      const matched = countHits(expected, acceptable, (key) => {
        const claim = claimByKey.get(key);
        return claim !== undefined && textMentions(text, claim.objectText ?? '', claim.summary);
      });
      const forbiddenHits = forbiddenClaims.filter((claim) =>
        textMentions(text, claim.objectText ?? '', claim.summary),
      ).length;
      recall = {
        triggered: hit !== null,
        chars: text.length,
        matched,
        forbiddenHits,
        rendered: options.dumpPrompt && hit ? hit.prefix : null,
      };
    }

    return {
      id: sampleId,
      family,
      extraction: {
        expected: expected.size,
        matched: matchedCount,
        forbiddenHits: forbiddenClaims.length,
        extra: claims.length - matchedExpected.length - forbiddenClaims.length,
        secretClaims: claims.filter((claim) => claim.sensitivity === 'secret').length,
        workerError: workerResult.inactive ? 'inactive (no usable model)' : null,
        claims: claims.map((claim) => ({
          predicate: claim.predicate,
          object: claim.objectText,
          summary: claim.summary,
          sensitivity: claim.sensitivity,
        })),
      },
      brief: {
        chars: rendered.length,
        matched: briefMatched,
        noise: briefNoise,
        forbiddenHits: briefForbidden,
        stable: (brief?.markdown ?? '') === (briefAgain?.markdown ?? ''),
        rendered: options.dumpPrompt ? rendered : null,
      },
      recall,
    };
  } finally {
    store.close();
    db.close();
    fs.rmSync(memoryDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function textMentions(text: string, ...needles: string[]): boolean {
  const haystack = norm(text);
  return needles.some((needle) => needle.length > 0 && haystack.includes(norm(needle)));
}

// ---------------------------------------------------------------------------
// Self-check: built-in controls. They must behave without any provider key.

interface Control {
  name: string;
  sample: EvalSample;
  provider: LlmProvider;
  check(result: ScenarioResult): string | null;
}

function controls(): Control[] {
  const conversation: EvalSample['conversation'] = [
    { role: 'user', content: '我上个月搬到上海了，我不吃香菜。' },
    { role: 'assistant', content: '好的，记下了。' },
  ];
  const quote = '我上个月搬到上海了';
  const positiveSample: EvalSample = {
    id: 'control-positive',
    conversation,
    expectClaims: [{ predicate: 'lives_in', object: '上海' }],
    probe: { prompt: '上次说的搬家的事，我现在住哪？' },
  };
  const positiveProvider = fakeProvider('control-positive', (request) => {
    const sourceId = sourceIdOf(request) ?? 'missing';
    return claimJson({
      predicate: 'lives_in',
      object: '上海',
      summary: '住在上海',
      quote,
      sourceId,
    });
  });

  return [
    {
      name: 'positive: a correct claim scores 100%',
      sample: positiveSample,
      provider: positiveProvider,
      check(result) {
        if (result.extraction.matched !== 1) return `expected extraction 1/1, got ${result.extraction.matched}`;
        if (result.brief.matched !== 1) return `expected brief 1/1, got ${result.brief.matched}`;
        if (!result.brief.stable) return 'brief is not byte-stable across two builds';
        if (result.extraction.secretClaims !== 0) return 'secret claim leaked into the store';
        return null;
      },
    },
    {
      name: 'wrong object: label mismatch is detected',
      sample: {
        ...positiveSample,
        id: 'control-wrong-object',
        expectClaims: [{ predicate: 'lives_in', object: '上海' }],
        forbidClaims: [{ predicate: 'lives_in', object: '北京' }],
      },
      provider: fakeProvider('control-wrong-object', (request) =>
        claimJson({
          predicate: 'lives_in',
          object: '北京',
          summary: '住在北京',
          quote,
          sourceId: sourceIdOf(request) ?? 'missing',
        }),
      ),
      check(result) {
        if (result.extraction.matched !== 0) return 'wrong object was scored as a hit';
        if (result.extraction.forbiddenHits !== 1) return 'forbidden claim was not caught';
        if (result.brief.forbiddenHits !== 1) return 'forbidden claim reached the brief';
        return null;
      },
    },
    {
      name: 'secret: extraction never stores or injects it',
      sample: {
        id: 'control-secret',
        conversation: [{ role: 'user', content: '我的密码是 hunter2。' }],
        expectClaims: [],
      },
      provider: fakeProvider('control-secret', (request) =>
        JSON.stringify({
          claims: [
            {
              predicate: 'likes',
              object: 'hunter2',
              kind: 'fact',
              summary: '密码 hunter2',
              sensitivity: 'secret',
              evidence: [{ sourceId: sourceIdOf(request) ?? 'missing', quote: '我的密码是 hunter2' }],
            },
          ],
        }),
      ),
      check(result) {
        if (result.extraction.secretClaims !== 0) return 'secret claim was stored';
        if (result.extraction.extra !== 0) return 'secret claim counted as ordinary extraction';
        return null;
      },
    },
    {
      name: 'mutation: changing the label is visible in the metrics',
      sample: {
        ...positiveSample,
        id: 'control-mutation',
        expectClaims: [{ predicate: 'lives_in', object: '北京' }],
        forbidClaims: [],
      },
      provider: positiveProvider,
      check(result) {
        if (result.extraction.matched !== 0) return 'mutated label still reported a hit';
        return null;
      },
    },
  ];
}

async function runSelfCheck(): Promise<number> {
  console.log('memory-eval self-check (no provider needed)\n');
  let failures = 0;
  for (const control of controls()) {
    const result = await runScenario(control.sample, {
      provider: control.provider,
      model: fakeModel(control.provider),
      dumpPrompt: false,
    });
    const error = control.check(result);
    console.log(`${error === null ? 'PASS' : 'FAIL'}  ${control.name}`);
    if (error !== null) {
      failures += 1;
      console.log(`      ${error}`);
      console.log(`      extraction=${JSON.stringify(result.extraction)}`);
      console.log(`      brief=${JSON.stringify({ ...result.brief, rendered: undefined })}`);
    }
  }

  // Determinism: the same fixture and provider must produce the same report.
  const deterministicSample = controls()[0]!.sample;
  const deterministicProvider = controls()[0]!.provider;
  const first = await runScenario(deterministicSample, {
    provider: deterministicProvider,
    model: fakeModel(deterministicProvider),
    dumpPrompt: false,
  });
  const second = await runScenario(deterministicSample, {
    provider: deterministicProvider,
    model: fakeModel(deterministicProvider),
    dumpPrompt: false,
  });
  const deterministic = JSON.stringify(first) === JSON.stringify(second);
  console.log(`${deterministic ? 'PASS' : 'FAIL'}  determinism: identical report on a second run`);
  if (!deterministic) failures += 1;

  console.log(`\n${failures === 0 ? 'all controls passed' : `${failures} control(s) failed`}`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Live samples

function loadSamples(target: string): EvalSample[] {
  const stats = fs.statSync(target);
  const files = stats.isDirectory()
    ? fs
        .readdirSync(target)
        .filter((name) => name.endsWith('.jsonl') || name.endsWith('.json'))
        .map((name) => path.join(target, name))
    : [target];
  const samples: EvalSample[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text === '') continue;
    const rows = file.endsWith('.jsonl')
      ? text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : [text];
    for (const [index, row] of rows.entries()) {
      const parsed: unknown = JSON.parse(row);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const sample = entry as EvalSample;
        if (typeof sample.id !== 'string' || !Array.isArray(sample.conversation)) {
          throw new Error(`${file}:${index + 1}: sample needs id and conversation[]`);
        }
        samples.push(sample);
      }
    }
  }
  return samples;
}

interface ScenarioSummary {
  id: string;
  family: 'dev' | 'life';
  runs: ScenarioResult[];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function printTable(summaries: ScenarioSummary[]): void {
  const header = ['id', 'runs', 'extract', 'extra', 'forbid', 'secret', 'brief', 'noise', 'chars', 'stable', 'recall'];
  console.log(header.join('\t'));
  for (const summary of summaries) {
    const runs = summary.runs;
    const expected = runs.reduce((total, run) => total + run.extraction.expected, 0);
    const matched = runs.reduce((total, run) => total + run.extraction.matched, 0);
    const briefMatched = runs.reduce((total, run) => total + run.brief.matched, 0);
    const recalls = runs.filter((run) => run.recall !== null);
    const recallText =
      recalls.length === 0
        ? '—'
        : `${recalls.filter((run) => run.recall!.triggered).length}/${recalls.length} triggered`;
    console.log(
      [
        summary.id,
        String(runs.length),
        expected === 0 ? '—' : `${matched}/${expected}`,
        mean(runs.map((run) => run.extraction.extra)).toFixed(1),
        String(runs.reduce((total, run) => total + run.extraction.forbiddenHits, 0)),
        String(runs.reduce((total, run) => total + run.extraction.secretClaims, 0)),
        expected === 0 ? '—' : `${briefMatched}/${expected}`,
        mean(runs.map((run) => run.brief.noise)).toFixed(1),
        mean(runs.map((run) => run.brief.chars)).toFixed(0),
        runs.every((run) => run.brief.stable) ? 'yes' : 'NO',
        recallText,
      ].join('\t'),
    );
  }
}

function aggregate(summaries: ScenarioSummary[]) {
  const runs = summaries.flatMap((summary) => summary.runs);
  const sum = (pick: (result: ScenarioResult) => number): number =>
    runs.reduce((total, result) => total + pick(result), 0);
  const expected = sum((result) => result.extraction.expected);
  return {
    scenarios: summaries.length,
    runs: runs.length,
    extractionRecall: ratio(sum((result) => result.extraction.matched), expected),
    briefRecall: ratio(sum((result) => result.brief.matched), expected),
    extraClaims: mean(runs.map((result) => result.extraction.extra)),
    forbiddenHits: sum((result) => result.extraction.forbiddenHits + result.brief.forbiddenHits),
    secretClaims: sum((result) => result.extraction.secretClaims),
    briefNoise: mean(runs.map((result) => result.brief.noise)),
    unstableBriefs: runs.filter((result) => !result.brief.stable).length,
    recallScenarios: runs.filter((result) => result.recall?.triggered).length,
  };
}

// ---------------------------------------------------------------------------
// CLI

interface Cli {
  mode: 'fake' | 'live' | 'help';
  samples: string | null;
  out: string | null;
  model: string | null;
  only: string | null;
  repeat: number;
  dumpPrompt: boolean;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    mode: 'help',
    samples: null,
    out: null,
    model: null,
    only: null,
    repeat: 1,
    dumpPrompt: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case '--fake':
        cli.mode = 'fake';
        break;
      case '--live':
        cli.mode = 'live';
        break;
      case '--samples':
        cli.samples = argv[++index] ?? null;
        break;
      case '--out':
        cli.out = argv[++index] ?? null;
        break;
      case '--model':
        cli.model = argv[++index] ?? null;
        break;
      case '--only':
        cli.only = argv[++index] ?? null;
        break;
      case '--repeat': {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value < 1 || value > 20) {
          throw new Error('--repeat must be an integer between 1 and 20');
        }
        cli.repeat = value;
        break;
      }
      case '--dump-prompt':
        cli.dumpPrompt = true;
        break;
      case '--':
        // `pnpm run x -- --flag` forwards the separator itself.
        break;
      case '--help':
      case '-h':
        cli.mode = 'help';
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return cli;
}

function printHelp(): void {
  console.log(`memory-eval — memory extraction & injection evaluation

  pnpm eval:memory -- --fake
      Run built-in controls; no provider or key needed. Exit 1 if they fail.

  pnpm eval:memory -- --live --samples <dir|file> [options]
      Run real samples through the configured memory model.

Options:
  --model <provider:model>  Override the memory model (else PABOOT_MEMORY_MODEL)
  --only <id>               Only run one scenario
  --repeat <n>              Run every scenario n times (1–20); live output is a mean
  --dump-prompt             Print the rendered brief / recall for each scenario
  --out <file>              Write the JSON report

Sample (JSONL, one object per line):
  {"id":"s01","family":"life",
   "conversation":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
   "expectClaims":[{"predicate":"lives_in","object":"上海"}],
   "forbidClaims":[{"predicate":"lives_in","object":"北京"}],
   "probe":{"prompt":"上次说的搬家，我现在住哪？"},
   "notes":"..."}`);
}

async function runLive(cli: Cli): Promise<number> {
  if (!cli.samples) throw new Error('--live needs --samples <dir|file>');
  const modelId = cli.model ?? process.env.PABOOT_MEMORY_MODEL ?? null;
  if (!modelId) {
    throw new Error('no memory model: pass --model provider:model or set PABOOT_MEMORY_MODEL');
  }
  const model = await resolveMemoryModel(modelId);
  if (!model) {
    throw new Error(
      `memory model "${modelId}" is not usable: it must be an enabled model with a configured API key`,
    );
  }

  let samples = loadSamples(cli.samples);
  if (cli.only) samples = samples.filter((sample) => sample.id === cli.only);
  if (samples.length === 0) throw new Error('no samples matched');

  console.log(
    `memory-eval live: ${samples.length} scenario(s) × ${cli.repeat} run(s), model ${model.modelId}\n`,
  );
  const summaries: ScenarioSummary[] = [];
  for (const sample of samples) {
    const runs: ScenarioResult[] = [];
    for (let run = 1; run <= cli.repeat; run += 1) {
      process.stdout.write(`running ${sample.id} (${run}/${cli.repeat})…\n`);
      runs.push(
        await runScenario(sample, { provider: model.provider, model, dumpPrompt: cli.dumpPrompt }),
      );
    }
    summaries.push({ id: sample.id, family: sample.family ?? 'life', runs });
  }

  console.log('');
  printTable(summaries);
  const summary = aggregate(summaries);
  console.log(
    `\nscenarios=${summary.scenarios} runs=${summary.runs} ` +
      `extractionRecall=${fmt(summary.extractionRecall)} ` +
      `briefRecall=${fmt(summary.briefRecall)} extra=${summary.extraClaims.toFixed(1)} ` +
      `forbidden=${summary.forbiddenHits} secret=${summary.secretClaims} ` +
      `briefNoise=${summary.briefNoise.toFixed(1)} unstableBriefs=${summary.unstableBriefs} ` +
      `recallHits=${summary.recallScenarios}`,
  );

  if (cli.dumpPrompt) {
    // With repeats, show the first run; the point is to inspect the prompt, not
    // to read the same shape N times.
    for (const entry of summaries) {
      const result = entry.runs[0];
      if (!result) continue;
      console.log(`\n----- ${result.id} claims -----`);
      for (const claim of result.extraction.claims) {
        console.log(
          `  ${claim.predicate} → ${claim.object ?? '(null)'} [${claim.sensitivity}] ${claim.summary}`,
        );
      }
      if (result.brief.rendered) {
        console.log(`\n----- ${result.id} brief -----\n${result.brief.rendered}`);
      }
      if (result.recall?.rendered) {
        console.log(`\n----- ${result.id} recall -----\n${result.recall.rendered}`);
      }
    }
  }

  if (cli.out) {
    fs.mkdirSync(path.dirname(path.resolve(cli.out)), { recursive: true });
    fs.writeFileSync(
      cli.out,
      JSON.stringify(
        {
          model: model.modelId,
          repeat: cli.repeat,
          summary,
          scenarios: summaries.map((entry) => ({
            id: entry.id,
            family: entry.family,
            runs: entry.runs,
          })),
        },
        null,
        2,
      ),
    );
    console.log(`\nreport written to ${cli.out}`);
  }
  return 0;
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.mode === 'help') {
    printHelp();
    return;
  }
  const code = cli.mode === 'fake' ? await runSelfCheck() : await runLive(cli);
  process.exitCode = code;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
