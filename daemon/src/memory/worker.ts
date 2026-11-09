import {
  MemoryExtractionError,
  claimDedupKey,
  extractMemory,
  type ExtractionResult,
} from './extract.js';
import type { MemoryModelSelection } from './model.js';
import type { MemoryStore } from './store.js';
import type { MemorySource } from './types.js';
import { log } from '../platform/log.js';

export interface MemoryWorkerOptions {
  store: MemoryStore;
  /** Resolve the explicitly configured memory model; null = record-only. */
  resolveModel: () => Promise<MemoryModelSelection | null>;
  /** Fallback sweep interval for backlog / provider recovery. */
  intervalMs?: number;
  /** Wait this long after a session's last capture before spending an LLM call. */
  debounceMs?: number;
  /** Bypass the debounce once one session has this many pending messages. */
  minBatchSources?: number;
  /** Pending sources considered per sweep. */
  batchSize?: number;
  /** Max messages in one LLM call. Turn boundaries are never split. */
  maxBatchSources?: number;
  /**
   * Optional fixed character cap for one LLM batch. When omitted the cap is
   * derived from the model's context window (see `batchCharBudget`).
   */
  maxBatchChars?: number;
  /** Already-processed messages supplied as read-only context. */
  contextSources?: number;
  /** Parse failures tolerated per source before it is parked. */
  failureLimit?: number;
  now?: () => number;
}

export interface MemoryWorkerResult {
  /** True when no provider/model is configured; sources stay pending. */
  inactive: boolean;
  processed: number;
  extracted: number;
  skipped: number;
  failed: number;
}

const INACTIVE: MemoryWorkerResult = {
  inactive: true,
  processed: 0,
  extracted: 0,
  skipped: 0,
  failed: 0,
};

const BUSY: MemoryWorkerResult = {
  inactive: false,
  processed: 0,
  extracted: 0,
  skipped: 0,
  failed: 0,
};

/**
 * Single-writer consolidation loop. M0 only turns pending L0 sources into
 * claims; M1 adds observation/summary and M2 adds dedup/merge/strength.
 *
 * Capture stays immediate. Extraction is debounced per session: a single turn
 * waits for more context (or the idle window), while a burst is extracted once
 * one session reaches `minBatchSources`. Batches only split at turn boundaries,
 * so the user message and its assistant reply always share one LLM call.
 *
 * Provider/transport failures never mark a source extracted: the batch stays
 * pending so configuring a provider later digests the backlog.
 */
export class MemoryWorker {
  private readonly store: MemoryStore;
  private readonly resolveModel: () => Promise<MemoryModelSelection | null>;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly minBatchSources: number;
  private readonly batchSize: number;
  private readonly maxBatchSources: number;
  private readonly maxBatchChars: number | undefined;
  private readonly contextSources: number;
  private readonly failureLimit: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private activeRun: Promise<MemoryWorkerResult> | null = null;

  constructor(options: MemoryWorkerOptions) {
    this.store = options.store;
    this.resolveModel = options.resolveModel;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.debounceMs = options.debounceMs ?? 30_000;
    this.minBatchSources = options.minBatchSources ?? 6;
    this.batchSize = options.batchSize ?? 200;
    this.maxBatchSources = options.maxBatchSources ?? 20;
    this.maxBatchChars = options.maxBatchChars;
    this.contextSources = options.contextSources ?? 4;
    this.failureLimit = options.failureLimit ?? 3;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.safeTick(), this.intervalMs);
    this.timer.unref?.();
    // Drain whatever survived a restart without waiting for the first sweep.
    setImmediate(() => this.safeTick());
  }

  /** Stop scheduling and give an in-flight batch a short chance to finish. */
  async stop(waitMs = 2_000): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearDebounce();
    const active = this.activeRun;
    if (!active) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      void active.then(
        () => finish(),
        (err: unknown) => {
          log.warn('memory worker active run failed during stop', err);
          finish();
        },
      );
    });
  }

  /**
   * All background entry points go through here. The worker writes to a
   * separate SQLite file and must never turn a transient disk/DB/provider
   * failure into an unhandled rejection that terminates the daemon.
   */
  private safeRun(): void {
    if (this.stopped || this.running) return;
    const run = this.runOnce();
    this.activeRun = run;
    void run
      .catch((err: unknown) => log.warn('memory worker run failed', err))
      .finally(() => {
        if (this.activeRun === run) this.activeRun = null;
      });
  }

  private safeTick(): void {
    if (this.stopped) return;
    try {
      this.tick();
    } catch (err) {
      log.warn('memory worker tick failed', err);
    }
  }

  /**
   * Capture finished. If one session already accumulated enough pending
   * messages, extract now; otherwise wait for the debounce window so
   * consecutive turns share one extraction call.
   */
  kick(): void {
    if (this.stopped) return;
    try {
      this.clearDebounce();
      const stats = this.store.pendingSessionStats();
      if (stats.length === 0) return;
      if (stats.some((session) => session.count >= this.minBatchSources)) {
        setImmediate(() => this.safeRun());
        return;
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.safeRun();
      }, this.debounceMs);
      this.debounceTimer.unref?.();
    } catch (err) {
      log.warn('memory worker kick failed', err);
    }
  }

  /** Interval/sweep entry: per-session threshold or idle window. */
  tick(): void {
    if (this.running) return;
    const stats = this.store.pendingSessionStats();
    if (stats.length === 0) return;
    const now = this.now();
    const ready = stats.some(
      (session) =>
        session.count >= this.minBatchSources ||
        now - session.lastCreatedAt >= this.debounceMs,
    );
    if (ready) this.safeRun();
  }

  /** Force one extraction pass. Called by timers and directly by tests/tools. */
  async runOnce(): Promise<MemoryWorkerResult> {
    if (this.running) return BUSY;
    this.running = true;
    this.clearDebounce();
    try {
      const pending = this.store.listPendingSources(this.batchSize);
      if (pending.length === 0) return BUSY;

      const model = await this.resolveModel().catch((err: unknown) => {
        log.warn('memory model resolution failed', err);
        return null;
      });
      if (!model || !model.provider.available) {
        this.store.setState('last_provider_missing_at', String(this.now()));
        return INACTIVE;
      }

      const result: MemoryWorkerResult = {
        inactive: false,
        processed: 0,
        extracted: 0,
        skipped: 0,
        failed: 0,
      };
      const maxBatchChars = this.maxBatchChars ?? batchCharBudget(model.modelConfig.contextWindow);
      for (const session of groupBySession(pending)) {
        for (const batch of batchTurns(session.turns, this.maxBatchSources, maxBatchChars)) {
          const first = batch[0]!;
          const context =
            session.sessionId === null
              ? []
              : this.store.listSessionSourcesBefore(
                  first.scope,
                  session.sessionId,
                  first.rowId,
                  this.contextSources,
                );
          await this.processGroup(batch, context, model, result);
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private clearDebounce(): void {
    if (!this.debounceTimer) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private async processGroup(
    sources: MemorySource[],
    contextSources: MemorySource[],
    model: MemoryModelSelection,
    result: MemoryWorkerResult,
  ): Promise<void> {
    const first = sources[0]!;
    const batchKey = `extract:${first.scope}:${sources[0]!.id}:${sources.length}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const extraction = await this.extractWithRetry(
        sources,
        contextSources,
        model,
        controller.signal,
      );
      const claims = extraction.claims;
      for (const [index, claim] of claims.entries()) {
        const claimRow = this.store.insertClaim(
          {
            scope: first.scope,
            endId: first.endId,
            predicate: claim.predicate,
            objectText: claim.objectText,
            kind: claim.kind,
            summary: claim.summary,
            authority: 'derived',
            validFrom: claim.validFrom,
            timePrecision: claim.timePrecision,
            confidence: claim.confidence,
            importance: claim.importance,
            dedupKey: claimDedupKey(claim.predicate, claim.objectText),
            sensitivity: claim.sensitivity,
            status: 'active',
          },
          claim.evidence.map((item) => ({
            sourceId: item.sourceId,
            quote: item.quote,
            relation: 'supports' as const,
          })),
        );
        this.store.recordOp({
          batchKey,
          opIndex: index,
          op: 'add',
          targetType: 'claim',
          targetId: claimRow.id,
          payload: { predicate: claim.predicate, objectText: claim.objectText, sourceIds: claim.evidence.map((e) => e.sourceId) },
        });
      }

      const sourceId = first.id;
      // Mechanical files are server-authoritative; keep them when the LLM
      // observation replaces the baseline row.
      const baseline = this.store.findObservationForSource(first.scope, sourceId);
      if (extraction.observations.length > 0) {
        this.store.replaceObservationsForSource(first.scope, sourceId);
        for (const observation of extraction.observations) {
          this.store.upsertObservation({
            scope: first.scope,
            endId: first.endId,
            sessionId: first.sessionId,
            runId: first.runId,
            sourceId,
            kind: observation.kind,
            type: observation.type,
            title: observation.title,
            subtitle: observation.subtitle,
            facts: observation.facts,
            narrative: observation.narrative,
            concepts: observation.concepts,
            filesRead: baseline?.filesRead ?? [],
            filesModified: baseline?.filesModified ?? [],
            sensitivity: observation.sensitivity,
          });
        }
      }
      if (extraction.summary && first.sessionId) {
        this.store.upsertSessionSummary({
          scope: first.scope,
          endId: first.endId,
          sessionId: first.sessionId,
          runId: first.runId,
          request: extraction.summary.request,
          investigated: extraction.summary.investigated,
          learned: extraction.summary.learned,
          completed: extraction.summary.completed,
          nextSteps: extraction.summary.nextSteps,
          notes: extraction.summary.notes,
          filesRead: baseline?.filesRead ?? [],
          filesEdited: baseline?.filesModified ?? [],
        });
        if (extraction.summary.nextSteps.trim() !== '') {
          this.store.upsertLoopCandidate({
            scope: first.scope,
            endId: first.endId,
            title: extraction.summary.nextSteps.trim().slice(0, 200),
            detail: extraction.summary.notes,
            sourceId,
          });
        }
      }

      const durable =
        claims.length > 0 ||
        extraction.observations.length > 0 ||
        extraction.summary !== null;
      const status = durable ? 'extracted' : 'skipped';
      for (const source of sources) {
        this.store.setSourceStatus(source.id, status);
        this.store.setState(`extract_failures:${source.id}`, '0');
        result.processed += 1;
        if (status === 'extracted') result.extracted += 1;
        else result.skipped += 1;
      }
      this.store.setState('last_consolidated_at', String(this.now()));
      this.store.setState('last_success_at', String(this.now()));
      this.store.setState('consecutive_failures', '0');
      this.store.setState('last_extraction_error', '');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const deterministic = isDeterministicExtractionFailure(err);
      log.warn(`memory extraction failed for ${batchKey}: ${message}`);
      for (const source of sources) {
        result.processed += 1;
        result.failed += 1;
        if (deterministic) {
          this.recordFailure(source, message);
        } else {
          // Transport/auth/quota/disk failures may recover. Keep the source
          // pending so a later provider/key/config change can drain it.
          this.store.setState(`extract_last_error:${source.id}`, message);
        }
      }
      this.store.setState('last_extraction_error', message);
      this.store.setState('last_extraction_error_at', String(this.now()));
      const consecutive = Number(this.store.getState('consecutive_failures') ?? 0) + 1;
      this.store.setState('consecutive_failures', String(consecutive));
    } finally {
      clearTimeout(timer);
    }
  }

  private async extractWithRetry(
    sources: MemorySource[],
    contextSources: MemorySource[],
    model: MemoryModelSelection,
    signal: AbortSignal,
  ): Promise<ExtractionResult> {
    try {
      return await extractMemory({
        provider: model.provider,
        providerId: model.providerId,
        model: model.model,
        sources,
        contextSources,
        signal,
      });
    } catch (err) {
      // Schema drift is worth one retry; transport/quota failures are not.
      if (
        err instanceof MemoryExtractionError &&
        (err.code === 'invalid_json' || err.code === 'invalid_schema')
      ) {
        return extractMemory({
          provider: model.provider,
          providerId: model.providerId,
          model: model.model,
          sources,
          contextSources,
          signal,
        });
      }
      throw err;
    }
  }

  private recordFailure(source: MemorySource, message: string): void {
    const key = `extract_failures:${source.id}`;
    const failures = Number(this.store.getState(key) ?? 0) + 1;
    this.store.setState(key, String(failures));
    if (failures >= this.failureLimit) {
      this.store.setSourceStatus(source.id, 'skipped');
      this.store.setState(`extract_dead:${source.id}`, message);
    }
  }
}

function isDeterministicExtractionFailure(err: unknown): boolean {
  return (
    err instanceof MemoryExtractionError &&
    (err.code === 'invalid_json' || err.code === 'invalid_schema')
  );
}

interface SourceTurn {
  sources: MemorySource[];
}

interface SessionTurns {
  sessionId: string | null;
  turns: SourceTurn[];
}

/**
 * One turn = one run's messages. A turn is never split: the user message and
 * the assistant reply (and any future tool events) share one extraction call.
 */
function groupTurns(sources: readonly MemorySource[]): SourceTurn[] {
  const turns = new Map<string, SourceTurn>();
  for (const source of sources) {
    const key = [
      source.scope,
      source.endId ?? '',
      source.sessionId ?? '',
      source.runId ?? source.id,
    ].join('|');
    const turn = turns.get(key) ?? { sources: [] };
    turn.sources.push(source);
    turns.set(key, turn);
  }
  return [...turns.values()];
}

function groupBySession(sources: readonly MemorySource[]): SessionTurns[] {
  const sessions = new Map<string, SessionTurns>();
  for (const turn of groupTurns(sources)) {
    const first = turn.sources[0]!;
    const key = [first.scope, first.endId ?? '', first.sessionId ?? ''].join('|');
    const session = sessions.get(key) ?? { sessionId: first.sessionId, turns: [] };
    session.turns.push(turn);
    sessions.set(key, session);
  }
  return [...sessions.values()];
}

/**
 * Character budget derived from the model window. CJK is roughly 1 token per
 * character, so keeping 75% of the window leaves room for the system prompt,
 * output and provider overhead. Unknown windows fall back to 32K tokens.
 */
function batchCharBudget(contextWindow: number | undefined): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 32_000;
  return Math.max(8_000, Math.floor(window * 0.75));
}

/** Split only between whole turns; an oversized turn stays intact. */
function batchTurns(
  turns: readonly SourceTurn[],
  maxSources: number,
  maxChars: number,
): MemorySource[][] {
  const batches: MemorySource[][] = [];
  let current: MemorySource[] = [];
  let chars = 0;
  for (const turn of turns) {
    const turnChars = turn.sources.reduce((sum, source) => sum + source.content.length, 0);
    if (
      current.length > 0 &&
      (current.length + turn.sources.length > maxSources || chars + turnChars > maxChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(...turn.sources);
    chars += turnChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
