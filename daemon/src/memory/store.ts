import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_SCHEMA_SQL, MEMORY_SCHEMA_VERSION } from './schema.js';
import { claimDedupKey } from './extract.js';
import type {
  CreateClaimInput,
  CreateSourceInput,
  ClaimEvidenceInput,
  MemoryClaim,
  MemoryDocument,
  MemoryEntity,
  MemoryObservation,
  MemoryScope,
  MemorySessionSummary,
  MemorySource,
  SourceStatus,
  UpsertDocumentInput,
  UpsertEntityInput,
  UpsertObservationInput,
  UpsertSessionSummaryInput,
} from './types.js';

const SOURCE_COLUMNS = `
  rowid AS rowId, id, scope, workspace_id AS workspaceId, end_id AS endId, kind,
  source_table AS sourceTable, session_id AS sessionId, run_id AS runId,
  message_id AS messageId, occurred_at AS occurredAt, content,
  content_hash AS contentHash, meta_json AS metaJson, sensitivity, status,
  created_at AS createdAt`;

const CLAIM_COLUMNS = `
  id, scope, end_id AS endId, entity_id AS entityId, predicate,
  object_text AS objectText, object_entity_id AS objectEntityId, kind, summary,
  authority, share_class AS shareClass, promoted_from AS promotedFrom,
  valid_from AS validFrom, valid_to AS validTo, time_precision AS timePrecision,
  confidence, importance, reinforcement_dates AS reinforcementDates,
  dedup_key AS dedupKey, sensitivity, status, superseded_by AS supersededBy,
  created_at AS createdAt, updated_at AS updatedAt`;

/** Predicates where a newer value replaces the previous one. */
const FUNCTIONAL_PREDICATES = new Set(['lives_in', 'works_at', 'name', 'birthday']);

/** D33: approximate dedup only starts once the scope has some history. */
const TIER1_MIN_CORPUS = 20;
const TIER1_THRESHOLD = 0.72;
const TIER1_POSTING_LIMIT = 200;

const ENTITY_COLUMNS = `
  id, scope, kind, canonical_name AS canonicalName, aliases_json AS aliasesJson,
  importance, sensitivity, status, merged_into AS mergedInto,
  created_at AS createdAt, updated_at AS updatedAt`;

const DOCUMENT_COLUMNS = `
  id, scope, end_id AS endId, kind, title, summary, tags_json AS tagsJson,
  path, origin, authority, weight, review_status AS reviewStatus,
  extractable, sensitivity, content_hash AS contentHash,
  last_edited_by AS lastEditedBy, updated_at AS updatedAt`;

const OBSERVATION_COLUMNS = `
  id, scope, end_id AS endId, session_id AS sessionId, run_id AS runId,
  source_id AS sourceId, kind, type, title, subtitle,
  facts_json AS factsJson, narrative, concepts_json AS conceptsJson,
  files_read_json AS filesReadJson, files_modified_json AS filesModifiedJson,
  evidence_json AS evidenceJson, content_hash AS contentHash, sensitivity, status,
  created_at AS createdAt, updated_at AS updatedAt`;

const SUMMARY_COLUMNS = `
  id, scope, end_id AS endId, session_id AS sessionId, run_id AS runId,
  request, investigated, learned, completed, next_steps AS nextSteps, notes,
  files_read_json AS filesReadJson, files_edited_json AS filesEditedJson,
  sensitivity, created_at AS createdAt`;

/**
 * Owns `<dataDir>/memory/memory.db`. One process writer; WAL is advertised so a
 * future read-only inspector can attach without blocking consolidation.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly file: string;

  constructor(dataDir: string) {
    const dir = path.join(dataDir, 'memory');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'memory.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec(MEMORY_SCHEMA_SQL);
    this.setState('schema_version', String(MEMORY_SCHEMA_VERSION), false);
    this.backfillSearchIndex();
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Number(this.getState('schema_version') ?? 0);
  }

  getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM mem_state WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string, overwrite = true): void {
    if (!overwrite && this.getState(key) !== null) return;
    this.db
      .prepare(
        `INSERT INTO mem_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ---- sources ----

  /**
   * Idempotent insert. The unique key is the documented
   * `scope + end + session + source_table + message_id|content_hash`, so the
   * same message replayed after a crash does not create a second source.
   */
  insertSource(input: CreateSourceInput): { source: MemorySource; created: boolean } {
    const content = input.content;
    if (content.trim() === '') throw new Error('memory source content is empty');
    const contentHash = hashContent(content);
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO mem_sources
           (id, scope, workspace_id, end_id, kind, source_table, session_id, run_id,
            message_id, occurred_at, content, content_hash, meta_json, sensitivity,
            status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.workspaceId ?? null,
        input.endId ?? null,
        input.kind,
        input.sourceTable ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        input.messageId ?? null,
        input.occurredAt,
        content,
        contentHash,
        JSON.stringify(input.meta ?? {}),
        input.sensitivity ?? 'normal',
        input.status ?? 'pending',
        Date.now(),
      );
    const source = this.findSourceByKey(input, contentHash);
    if (!source) throw new Error('failed to read back memory source');
    if (Number(result.changes) > 0 && source.sensitivity !== 'secret') {
      this.indexSearch({
        scope: source.scope,
        endId: source.endId,
        kind: 'source',
        refId: source.id,
        authority: null,
        text: source.content,
      });
    }
    return { source, created: Number(result.changes) > 0 };
  }

  getSource(id: string): MemorySource | undefined {
    return this.db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM mem_sources WHERE id = ?`)
      .get(id) as unknown as MemorySource | undefined;
  }

  findSourceForRun(scope: MemoryScope, runId: string): MemorySource | undefined {
    return this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM mem_sources
         WHERE scope = ? AND run_id = ? ORDER BY rowid ASC LIMIT 1`,
      )
      .get(scope, runId) as unknown as MemorySource | undefined;
  }

  listSources(scope: MemoryScope): MemorySource[] {
    return this.db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM mem_sources WHERE scope = ? ORDER BY rowid ASC`)
      .all(scope) as unknown as MemorySource[];
  }

  listPendingSources(limit = 20, scope?: MemoryScope): MemorySource[] {
    if (scope) {
      return this.db
        .prepare(
          `SELECT ${SOURCE_COLUMNS} FROM mem_sources
           WHERE scope = ? AND status = 'pending' ORDER BY rowid ASC LIMIT ?`,
        )
        .all(scope, limit) as unknown as MemorySource[];
    }
    return this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM mem_sources
         WHERE status = 'pending' ORDER BY rowid ASC LIMIT ?`,
      )
      .all(limit) as unknown as MemorySource[];
  }

  /** Pending counts per session, for threshold/debounce decisions. */
  pendingSessionStats(): {
    scope: MemoryScope;
    endId: string | null;
    sessionId: string | null;
    count: number;
    lastCreatedAt: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT scope, end_id AS endId, session_id AS sessionId,
                COUNT(*) AS count, MAX(created_at) AS lastCreatedAt
         FROM mem_sources
         WHERE status = 'pending'
         GROUP BY scope, COALESCE(end_id, ''), COALESCE(session_id, '')`,
      )
      .all() as unknown as {
      scope: MemoryScope;
      endId: string | null;
      sessionId: string | null;
      count: number;
      lastCreatedAt: number;
    }[];
    return rows.map((row) => ({
      scope: row.scope,
      endId: row.endId,
      sessionId: row.sessionId,
      count: Number(row.count),
      lastCreatedAt: Number(row.lastCreatedAt),
    }));
  }

  /** The last `limit` captured sources before a pending turn, oldest first. */
  listSessionSourcesBefore(
    scope: MemoryScope,
    sessionId: string,
    rowId: number,
    limit: number,
  ): MemorySource[] {
    const rows = this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM mem_sources
         WHERE scope = ? AND session_id = ? AND rowid < ?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(scope, sessionId, rowId, limit) as unknown as MemorySource[];
    return rows.reverse();
  }

  setSourceStatus(id: string, status: SourceStatus): void {
    this.db.prepare(`UPDATE mem_sources SET status = ? WHERE id = ?`).run(status, id);
  }

  /** Message ids already captured from the main `messages` table. */
  capturedMessageIds(scope: MemoryScope, sessionId: string): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT message_id AS messageId FROM mem_sources
         WHERE scope = ? AND session_id = ? AND source_table = 'messages'
           AND message_id IS NOT NULL`,
      )
      .all(scope, sessionId) as unknown as { messageId: number }[];
    return new Set(rows.map((row) => Number(row.messageId)));
  }

  countSources(status: SourceStatus, scope?: MemoryScope): number {
    const row = scope
      ? (this.db
          .prepare(`SELECT COUNT(*) AS count FROM mem_sources WHERE scope = ? AND status = ?`)
          .get(scope, status) as { count: number })
      : (this.db
          .prepare(`SELECT COUNT(*) AS count FROM mem_sources WHERE status = ?`)
          .get(status) as { count: number });
    return Number(row.count);
  }

  // ---- ops (audit + replay idempotency) ----

  recordOp(input: {
    batchKey: string;
    opIndex: number;
    op: string;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
  }): void {
    const id = createHash('sha256').update(`${input.batchKey}|${input.opIndex}`, 'utf8').digest('hex');
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mem_ops
           (id, batch_key, op, target_type, target_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.batchKey,
        input.op,
        input.targetType,
        input.targetId,
        JSON.stringify(input.payload),
        Date.now(),
      );
  }

  // ---- tombstones ----

  addTombstone(input: {
    scope: MemoryScope;
    endId?: string | null;
    contentHash: string;
    reason?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO mem_tombstones (id, scope, end_id, content_hash, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.scope,
        input.endId ?? null,
        input.contentHash,
        input.reason ?? null,
        Date.now(),
      );
  }

  hasTombstone(scope: MemoryScope, endId: string | null, contentHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM mem_tombstones
         WHERE scope = ? AND COALESCE(end_id, '') = ? AND content_hash = ? LIMIT 1`,
      )
      .get(scope, endId ?? '', contentHash);
    return row !== undefined;
  }

  // ---- entities ----

  /**
   * Exact canonical/alias match inside the scope. Cross-scope identity stays a
   * link (`mem_entity_links`), never an implicit merge (D7 / M2).
   */
  upsertEntity(input: UpsertEntityInput): MemoryEntity {
    const canonical = normalizeEntityName(input.name);
    if (canonical === '') throw new Error('entity name is empty');
    const rows = this.db
      .prepare(
        `SELECT ${ENTITY_COLUMNS} FROM mem_entities
         WHERE scope = ? AND kind = ? AND status = 'active'`,
      )
      .all(input.scope, input.kind) as unknown as RawEntity[];
    const match = rows
      .map(mapEntity)
      .find(
        (entity) =>
          normalizeEntityName(entity.canonicalName) === canonical ||
          entity.aliases.some((alias) => normalizeEntityName(alias) === canonical),
      );
    if (match) {
      const aliases = new Set([
        match.canonicalName,
        ...match.aliases,
        input.name,
        ...(input.aliases ?? []),
      ]);
      aliases.delete(match.canonicalName);
      this.db
        .prepare(
          `UPDATE mem_entities SET aliases_json = ?, importance = MAX(importance, ?),
             updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify([...aliases]), input.importance ?? match.importance, Date.now(), match.id);
      return this.getEntity(match.id)!;
    }
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mem_entities
           (id, scope, kind, canonical_name, aliases_json, attributes_json, importance,
            sensitivity, status, merged_into, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.kind,
        input.name.trim(),
        JSON.stringify(input.aliases ?? []),
        input.importance ?? 0.5,
        input.sensitivity ?? 'normal',
        now,
        now,
      );
    return this.getEntity(id)!;
  }

  getEntity(id: string): MemoryEntity | undefined {
    const row = this.db
      .prepare(`SELECT ${ENTITY_COLUMNS} FROM mem_entities WHERE id = ?`)
      .get(id) as unknown as RawEntity | undefined;
    return row ? mapEntity(row) : undefined;
  }

  listEntities(scope: MemoryScope): MemoryEntity[] {
    const rows = this.db
      .prepare(
        `SELECT ${ENTITY_COLUMNS} FROM mem_entities
         WHERE scope = ? AND status = 'active' ORDER BY importance DESC, created_at ASC`,
      )
      .all(scope) as unknown as RawEntity[];
    return rows.map(mapEntity);
  }

  /** Cross-scope / cross-family identity link; ordered to satisfy the CHECK. */
  linkEntities(a: string, b: string, relation: string, createdBy: string): void {
    if (a === b) return;
    const [first, second] = a < b ? [a, b] : [b, a];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mem_entity_links (entity_a, entity_b, relation, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(first, second, relation, createdBy, Date.now());
  }

  /** Explicit merge with rollback trail: aliases + claims move, source is marked. */
  mergeEntities(sourceId: string, targetId: string, createdBy: string): MemoryEntity | undefined {
    if (sourceId === targetId) return this.getEntity(targetId);
    const source = this.getEntity(sourceId);
    const target = this.getEntity(targetId);
    if (!source || !target) return undefined;
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`UPDATE mem_claims SET entity_id = ? WHERE entity_id = ?`)
        .run(targetId, sourceId);
      this.db
        .prepare(`UPDATE mem_claims SET object_entity_id = ? WHERE object_entity_id = ?`)
        .run(targetId, sourceId);
      const aliases = new Set([
        target.canonicalName,
        ...target.aliases,
        source.canonicalName,
        ...source.aliases,
      ]);
      aliases.delete(target.canonicalName);
      this.db
        .prepare(`UPDATE mem_entities SET aliases_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify([...aliases]), now, targetId);
      this.db
        .prepare(
          `UPDATE mem_entities SET status = 'merged', merged_into = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(targetId, now, sourceId);
      this.linkEntities(sourceId, targetId, 'merged', createdBy);
      this.recordOp({
        batchKey: `merge-entity:${sourceId}:${targetId}`,
        opIndex: 0,
        op: 'merge_entity',
        targetType: 'entity',
        targetId,
        payload: { merged: sourceId, createdBy },
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getEntity(targetId);
  }

  // ---- claims ----

  insertClaim(input: CreateClaimInput, evidence: readonly ClaimEvidenceInput[] = []): MemoryClaim {
    // Tier-0: an exact dedup key merges into the existing row instead of
    // creating a second claim. The unique-ish check stays in application code
    // because dedup_key is nullable and the index is not UNIQUE.
    const existing =
      (input.dedupKey ? this.findClaimByDedup(input) : undefined) ??
      this.findExactClaim(input);
    if (existing) {
      this.attachEvidence(existing.id, evidence);
      // Tier-0 never downgrades authority: a user-confirmed repeat promotes the
      // existing derived row, while a derived repeat leaves it confirmed.
      if (input.authority === 'user_confirmed' && existing.authority !== 'user_confirmed') {
        this.db
          .prepare(
            `UPDATE mem_claims
             SET authority = 'user_confirmed', confidence = 1.0,
                 summary = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.summary, Date.now(), existing.id);
      }
      this.recordOp({
        batchKey: `dedup:${existing.id}:${evidence.map((item) => item.sourceId).join(',')}`,
        opIndex: 0,
        op: 'merge',
        targetType: 'claim',
        targetId: existing.id,
        payload: { sourceIds: evidence.map((item) => item.sourceId) },
      });
      const refreshed = this.getClaim(existing.id) ?? existing;
      this.refreshClaimIndex(refreshed);
      return this.reinforceClaim(existing.id) ?? refreshed;
    }

    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO mem_claims
             (id, scope, end_id, entity_id, predicate, object_text, object_entity_id,
              kind, summary, authority, share_class, promoted_from, valid_from,
              valid_to, time_precision, confidence, importance, reinforcement_dates,
              dedup_key, sensitivity, status, superseded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.scope,
          input.endId ?? null,
          input.entityId ?? null,
          input.predicate,
          input.objectText ?? null,
          input.objectEntityId ?? null,
          input.kind,
          input.summary,
          input.authority ?? 'derived',
          input.shareClass ?? null,
          input.promotedFrom ?? null,
          input.validFrom ?? null,
          input.validTo ?? null,
          input.timePrecision ?? 'day',
          input.confidence,
          input.importance,
          JSON.stringify(input.reinforcementDates ?? []),
          input.dedupKey ?? null,
          input.sensitivity ?? 'normal',
          input.status ?? 'active',
          input.supersededBy ?? null,
          now,
          now,
        );
      this.attachEvidence(id, evidence);
      const claim = this.getClaim(id);
      if (!claim) throw new Error('failed to read back memory claim');
      this.refreshClaimIndex(claim);
      this.resolveClaimConflicts(claim);
      this.findTier1Duplicates(this.getClaim(id) ?? claim);
      this.db.exec('COMMIT');
      return this.getClaim(id) ?? claim;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private attachEvidence(claimId: string, evidence: readonly ClaimEvidenceInput[]): void {
    for (const item of evidence) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO mem_claim_evidence (claim_id, source_id, relation, quote)
           VALUES (?, ?, ?, ?)`,
        )
        .run(claimId, item.sourceId, item.relation ?? 'supports', item.quote ?? null);
    }
  }

  private findExactClaim(input: CreateClaimInput): MemoryClaim | undefined {
    if (!input.objectText || input.objectText.trim() === '') return undefined;
    const object = normalizeObject(input.objectText);
    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM mem_claims
         WHERE scope = ? AND COALESCE(end_id, '') = ? AND predicate = ?
           AND status = 'active'
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(input.scope, input.endId ?? '', input.predicate) as unknown as RawClaim[];
    const match = rows
      .map(mapClaim)
      .find((claim) => claim.objectText !== null && normalizeObject(claim.objectText) === object);
    return match;
  }

  /** D34: append today once; FIFO 10; confidence is intentionally unchanged. */
  reinforceClaim(id: string): MemoryClaim | undefined {
    const claim = this.getClaim(id);
    if (!claim) return undefined;
    const today = new Date().toISOString().slice(0, 10);
    if (claim.reinforcementDates.includes(today)) return claim;
    const dates = [...claim.reinforcementDates, today].slice(-10);
    this.db
      .prepare(`UPDATE mem_claims SET reinforcement_dates = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(dates), Date.now(), id);
    return this.getClaim(id);
  }

  /**
   * Deterministic conflict handling for functional predicates. Multi-valued
   * predicates (likes, plans, goals, relations) may legitimately have several
   * active objects, so they are left alone here.
   */
  private resolveClaimConflicts(claim: MemoryClaim): void {
    if (claim.status !== 'active') return;
    if (!FUNCTIONAL_PREDICATES.has(claim.predicate)) return;
    const candidates = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM mem_claims
         WHERE scope = ? AND COALESCE(end_id, '') = ? AND predicate = ?
           AND status = 'active' AND id <> ?
         ORDER BY updated_at DESC LIMIT 20`,
      )
      .all(claim.scope, claim.endId ?? '', claim.predicate, claim.id) as unknown as RawClaim[];

    for (const raw of candidates) {
      const old = mapClaim(raw);
      if (old.objectText === null || claim.objectText === null) continue;
      if (normalizeObject(old.objectText) === normalizeObject(claim.objectText)) continue;

      const newFrom = claim.validFrom;
      const oldFrom = old.validFrom;
      const oldTo = old.validTo;
      const newTo = claim.validTo;
      // Non-overlapping intervals are history, not a conflict.
      if (newFrom !== null && oldTo !== null && newFrom > oldTo) continue;
      if (newTo !== null && oldFrom !== null && newTo < oldFrom) continue;

      if (old.authority === 'user_confirmed') {
        this.updateClaim(claim.id, { status: 'disputed' });
        this.recordConflictOp('dispute', claim, old);
        return;
      }
      if (newFrom !== null && (oldFrom === null || newFrom >= oldFrom)) {
        const sameStart = oldFrom !== null && newFrom === oldFrom;
        if (sameStart && Math.abs(claim.confidence - old.confidence) < 0.15) {
          this.updateClaim(claim.id, { status: 'disputed' });
          this.updateClaim(old.id, { status: 'disputed' });
          this.recordConflictOp('dispute', claim, old);
          return;
        }
        this.updateClaim(old.id, {
          status: 'superseded',
          supersededBy: claim.id,
          validTo: newFrom,
        });
        this.recordConflictOp('supersede', claim, old);
        return;
      }
    }
  }

  private recordConflictOp(op: 'supersede' | 'dispute', claim: MemoryClaim, old: MemoryClaim): void {
    this.recordOp({
      batchKey: `conflict:${claim.id}:${old.id}`,
      opIndex: 0,
      op,
      targetType: 'claim',
      targetId: claim.id,
      payload: { supersedes: old.id, object: claim.objectText, previous: old.objectText },
    });
  }

  /**
   * D33 Tier-1: IDF-weighted cosine over summary/object tokens, same scope +
   * predicate. Never auto-merges; high-IDF tokens in the symmetric difference
   * veto a candidate so `ffmpeg-7.1` vs `6.1` cannot collapse into one row.
   */
  private findTier1Duplicates(claim: MemoryClaim): void {
    if (claim.status !== 'active' || claim.sensitivity === 'secret') return;
    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM mem_claims
         WHERE scope = ? AND status = 'active' AND id <> ?
         ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(claim.scope, claim.id) as unknown as RawClaim[];
    const corpus = rows.map(mapClaim);
    if (corpus.length + 1 < TIER1_MIN_CORPUS) return;

    const tokenCache = new Map<string, Set<string>>();
    const tokensOf = (row: MemoryClaim): Set<string> => {
      const cached = tokenCache.get(row.id);
      if (cached) return cached;
      const tokens = tokenizeForDedup(`${row.predicate} ${row.objectText ?? ''} ${row.summary}`);
      tokenCache.set(row.id, tokens);
      return tokens;
    };
    const claimTokens = tokenizeForDedup(
      `${claim.predicate} ${claim.objectText ?? ''} ${claim.summary}`,
    );
    if (claimTokens.size === 0) return;

    const df = new Map<string, number>();
    for (const row of corpus) {
      for (const token of tokensOf(row)) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const total = corpus.length + 1;
    const idf = (token: string): number => Math.log((total + 1) / ((df.get(token) ?? 0) + 1)) + 1;
    const rareDf = Math.max(1, Math.floor(total * 0.05));
    const norm = (tokens: Set<string>): number => {
      let sum = 0;
      for (const token of tokens) sum += idf(token) ** 2;
      return Math.sqrt(sum) || 1;
    };
    const claimNorm = norm(claimTokens);

    const candidates = corpus
      .filter((row) => row.predicate === claim.predicate && row.sensitivity !== 'secret')
      .slice(0, TIER1_POSTING_LIMIT);
    for (const existing of candidates) {
      const tokens = tokensOf(existing);
      const intersection = [...claimTokens].filter((token) => tokens.has(token));
      if (intersection.length === 0) continue;
      let dot = 0;
      for (const token of intersection) dot += idf(token) ** 2;
      const score = dot / (claimNorm * norm(tokens));
      if (!Number.isFinite(score) || score < TIER1_THRESHOLD) continue;

      const symmetric = new Set<string>();
      for (const token of claimTokens) if (!tokens.has(token)) symmetric.add(token);
      for (const token of tokens) if (!claimTokens.has(token)) symmetric.add(token);
      // Natural-language bigrams are expected to differ; the veto targets
      // identifier-like tokens (ffmpeg-7.1 vs 6.1, rdlp-api vs rdlp-plugin).
      const rareVeto = [...symmetric].some(
        (token) => /[0-9._-]/.test(token) && (df.get(token) ?? 0) <= rareDf,
      );
      if (rareVeto) continue;

      this.db
        .prepare(
          `INSERT OR IGNORE INTO mem_claim_duplicates
             (id, claim_id, duplicate_of, scope, method, score, status, created_at)
           VALUES (?, ?, ?, ?, 'tier1_cosine', ?, 'pending', ?)`,
        )
        .run(randomUUID(), claim.id, existing.id, claim.scope, score, Date.now());
    }
  }

  listClaimDuplicates(
    scope: MemoryScope,
    status = 'pending',
  ): ClaimDuplicateRow[] {
    return this.db
      .prepare(
        `SELECT id, claim_id AS claimId, duplicate_of AS duplicateOf, scope, score,
                method, status
         FROM mem_claim_duplicates WHERE scope = ? AND status = ?
         ORDER BY score DESC`,
      )
      .all(scope, status) as unknown as ClaimDuplicateRow[];
  }

  getClaimDuplicate(id: string): ClaimDuplicateRow | undefined {
    return this.db
      .prepare(
        `SELECT id, claim_id AS claimId, duplicate_of AS duplicateOf, scope, score,
                method, status
         FROM mem_claim_duplicates WHERE id = ?`,
      )
      .get(id) as unknown as ClaimDuplicateRow | undefined;
  }

  /**
   * Accept a Tier-1 candidate: move evidence to the surviving claim, reinforce
   * it, archive the duplicate, and mark the candidate merged. `user_confirmed`
   * always wins (the target is upgraded; it is never downgraded).
   */
  mergeClaimDuplicate(id: string, actor: string): MemoryClaim | undefined {
    const candidate = this.getClaimDuplicate(id);
    if (!candidate || candidate.status !== 'pending') return undefined;
    const source = this.getClaim(candidate.claimId);
    const target = this.getClaim(candidate.duplicateOf);
    if (!source || !target || source.id === target.id) return undefined;
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO mem_claim_evidence (claim_id, source_id, relation, quote)
           SELECT ?, source_id, relation, quote FROM mem_claim_evidence WHERE claim_id = ?`,
        )
        .run(target.id, source.id);
      this.db.prepare(`DELETE FROM mem_claim_evidence WHERE claim_id = ?`).run(source.id);
      if (source.authority === 'user_confirmed' && target.authority !== 'user_confirmed') {
        this.db
          .prepare(
            `UPDATE mem_claims SET authority = 'user_confirmed', confidence = 1.0,
               updated_at = ? WHERE id = ?`,
          )
          .run(now, target.id);
      }
      this.db
        .prepare(
          `UPDATE mem_claims SET status = 'archived', superseded_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(target.id, now, source.id);
      this.db
        .prepare(`DELETE FROM mem_search WHERE kind = 'claim' AND ref_id = ?`)
        .run(source.id);
      this.db
        .prepare(`UPDATE mem_claim_duplicates SET status = 'merged' WHERE id = ?`)
        .run(id);
      this.reinforceClaim(target.id);
      this.refreshClaimIndex(this.getClaim(target.id)!);
      this.recordOp({
        batchKey: `merge-claim:${source.id}:${target.id}`,
        opIndex: 0,
        op: 'merge_claim',
        targetType: 'claim',
        targetId: target.id,
        payload: { merged: source.id, actor },
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getClaim(target.id);
  }

  setClaimDuplicateStatus(id: string, status: 'merged' | 'distinct' | 'dismissed'): boolean {
    const result = this.db
      .prepare(`UPDATE mem_claim_duplicates SET status = ? WHERE id = ? AND status = 'pending'`)
      .run(status, id);
    return Number(result.changes) > 0;
  }

  /**
   * Promote a workspace claim to the user scope (life -> user). A new claim is
   * created with `promoted_from`; the source claim and the original evidence
   * stay untouched. Tier-0 still applies inside the user scope.
   */
  promoteClaim(
    id: string,
    shareClass: 'portable' | 'personal' | 'life_only' = 'portable',
  ): MemoryClaim | null {
    const source = this.getClaim(id);
    if (!source || source.scope === 'user' || source.sensitivity === 'secret') return null;
    const promoted = this.insertClaim(
      {
        scope: 'user',
        endId: null,
        entityId: source.entityId,
        predicate: source.predicate,
        objectText: source.objectText,
        objectEntityId: source.objectEntityId,
        kind: source.kind,
        summary: source.summary,
        authority: 'user_confirmed',
        shareClass,
        promotedFrom: source.id,
        validFrom: source.validFrom,
        validTo: source.validTo,
        timePrecision: source.timePrecision,
        confidence: source.confidence,
        importance: source.importance,
        dedupKey: source.dedupKey,
        sensitivity: source.sensitivity,
      },
      this.claimEvidence(source.id).map((item) => ({
        sourceId: item.sourceId,
        relation: item.relation as 'supports' | 'contradicts' | 'corrects',
        quote: item.quote,
      })),
    );
    this.recordOp({
      batchKey: `promote:${source.id}`,
      opIndex: 0,
      op: 'promote',
      targetType: 'claim',
      targetId: promoted.id,
      payload: { from: source.id, shareClass },
    });
    return promoted;
  }

  getClaim(id: string): MemoryClaim | undefined {
    const row = this.db.prepare(`SELECT ${CLAIM_COLUMNS} FROM mem_claims WHERE id = ?`).get(id) as
      | RawClaim
      | undefined;
    return row ? mapClaim(row) : undefined;
  }

  listClaims(scope: MemoryScope, status: string = 'active'): MemoryClaim[] {
    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM mem_claims
         WHERE scope = ? AND status = ? ORDER BY updated_at DESC`,
      )
      .all(scope, status) as unknown as RawClaim[];
    return rows.map(mapClaim);
  }

  updateClaim(
    id: string,
    patch: Partial<Pick<CreateClaimInput, 'summary' | 'objectText' | 'validTo' | 'confidence' | 'importance' | 'sensitivity' | 'status' | 'supersededBy'>>,
  ): MemoryClaim | undefined {
    const columns: string[] = [];
    const values: (string | number | null)[] = [];
    const mapping: Record<string, string> = {
      summary: 'summary',
      objectText: 'object_text',
      validTo: 'valid_to',
      confidence: 'confidence',
      importance: 'importance',
      sensitivity: 'sensitivity',
      status: 'status',
      supersededBy: 'superseded_by',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (key in patch) {
        columns.push(`${column} = ?`);
        values.push((patch as Record<string, string | number | null | undefined>)[key] ?? null);
      }
    }
    if (columns.length === 0) return this.getClaim(id);
    columns.push('updated_at = ?');
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE mem_claims SET ${columns.join(', ')} WHERE id = ?`).run(...values);
    const updated = this.getClaim(id);
    if (updated) this.refreshClaimIndex(updated);
    return updated;
  }

  /** User correction wins over extraction: authority + confidence are reset. */
  correctClaim(
    id: string,
    patch: { summary?: string; objectText?: string },
  ): MemoryClaim | undefined {
    const current = this.getClaim(id);
    if (!current) return undefined;
    const columns: string[] = [];
    const values: (string | number)[] = [];
    if (patch.summary !== undefined) {
      columns.push('summary = ?');
      values.push(patch.summary);
    }
    if (patch.objectText !== undefined) {
      columns.push('object_text = ?');
      values.push(patch.objectText);
      // The Tier-0 merge key describes the object value. Keeping the old key
      // after a user correction would let future extraction reinforce the
      // wrong value or create a duplicate for the corrected one.
      columns.push('dedup_key = ?');
      values.push(claimDedupKey(current.predicate, patch.objectText));
    }
    columns.push("authority = 'user_confirmed'", 'confidence = 1.0', 'updated_at = ?');
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE mem_claims SET ${columns.join(', ')} WHERE id = ?`).run(...values);
    const corrected = this.getClaim(id);
    if (corrected) this.refreshClaimIndex(corrected);
    return corrected;
  }

  /** Forget one claim: tombstone its evidence sources, then delete the row. */
  forgetClaim(id: string): boolean {
    const claim = this.getClaim(id);
    if (!claim) return false;
    const evidence = this.claimEvidence(id);
    for (const item of evidence) {
      const source = this.getSource(item.sourceId);
      if (source) {
        this.addTombstone({
          scope: claim.scope,
          endId: claim.endId,
          contentHash: source.contentHash,
          reason: 'forget',
        });
      }
    }
    this.db.prepare(`DELETE FROM mem_claim_evidence WHERE claim_id = ?`).run(id);
    this.db.prepare(`DELETE FROM mem_claims WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM mem_search WHERE kind = 'claim' AND ref_id = ?`).run(id);
    return true;
  }

  addFeedback(input: {
    targetType: string;
    targetId: string;
    action: string;
    note?: string | null;
    sessionId?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO mem_feedback (target_type, target_id, action, note, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.targetType,
        input.targetId,
        input.action,
        input.note ?? null,
        input.sessionId ?? null,
        Date.now(),
      );
  }

  claimEvidence(claimId: string): { sourceId: string; relation: string; quote: string | null }[] {
    return this.db
      .prepare(`SELECT source_id AS sourceId, relation, quote FROM mem_claim_evidence WHERE claim_id = ?`)
      .all(claimId) as unknown as { sourceId: string; relation: string; quote: string | null }[];
  }

  // ---- documents (K2) ----

  /**
   * Mirror a knowledge document. The file remains the source of truth; this
   * row and its chunks are only the search index. Chunks are rebuilt when the
   * body hash, title, summary or authority changes.
   */
  upsertDocument(input: UpsertDocumentInput & { body: string }): boolean {
    const existing = this.getDocument(input.id);
    const chunks = chunkDocument(input.body, input.title, input.summary);
    const changed =
      !existing ||
      existing.contentHash !== input.contentHash ||
      existing.title !== input.title ||
      existing.summary !== input.summary ||
      existing.authority !== input.authority;

    this.db
      .prepare(
        `INSERT INTO mem_documents
           (id, scope, end_id, kind, title, summary, tags_json, path, origin, authority,
            weight, review_status, extractable, sensitivity, content_hash, last_edited_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope, end_id = excluded.end_id, kind = excluded.kind,
           title = excluded.title, summary = excluded.summary, tags_json = excluded.tags_json,
           path = excluded.path, origin = excluded.origin, authority = excluded.authority,
           weight = excluded.weight, review_status = excluded.review_status,
           extractable = excluded.extractable, sensitivity = excluded.sensitivity,
           content_hash = excluded.content_hash, last_edited_by = excluded.last_edited_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.scope,
        input.endId,
        input.kind,
        input.title,
        input.summary,
        JSON.stringify(input.tags ?? []),
        input.path,
        input.origin,
        input.authority,
        input.weight ?? 1,
        input.reviewStatus,
        input.extractable ?? 0,
        input.sensitivity,
        input.contentHash,
        input.lastEditedBy,
        input.updatedAt,
      );

    if (!changed) return false;
    this.db.prepare(`DELETE FROM mem_document_chunks WHERE document_id = ?`).run(input.id);
    this.db.prepare(`DELETE FROM mem_search WHERE document_id = ?`).run(input.id);
    chunks.forEach((text, chunkNo) => {
      this.db
        .prepare(
          `INSERT INTO mem_document_chunks (id, document_id, chunk_no, text, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), input.id, chunkNo, text, hashContent(text), Date.now());
      this.indexSearch({
        scope: input.scope,
        endId: input.endId,
        kind: 'document',
        refId: input.id,
        authority: input.authority,
        documentId: input.id,
        chunkNo,
        text: `${input.title}\n${text}`,
      });
    });
    return true;
  }

  getDocument(id: string): MemoryDocument | undefined {
    const row = this.db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM mem_documents WHERE id = ?`).get(id) as
      | RawDocument
      | undefined;
    return row ? mapDocument(row) : undefined;
  }

  listDocuments(scope: MemoryScope): MemoryDocument[] {
    const rows = this.db
      .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM mem_documents WHERE scope = ? ORDER BY updated_at DESC`)
      .all(scope) as unknown as RawDocument[];
    return rows.map(mapDocument);
  }

  listDocumentChunks(documentId: string): { chunkNo: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT chunk_no AS chunkNo, text FROM mem_document_chunks
         WHERE document_id = ? ORDER BY chunk_no ASC`,
      )
      .all(documentId) as unknown as { chunkNo: number; text: string }[];
  }

  deleteDocument(id: string): void {
    this.db.prepare(`DELETE FROM mem_document_chunks WHERE document_id = ?`).run(id);
    this.db.prepare(`DELETE FROM mem_search WHERE document_id = ?`).run(id);
    this.db.prepare(`DELETE FROM mem_documents WHERE id = ?`).run(id);
  }

  // ---- observations / session summaries (M1) ----

  upsertObservation(input: UpsertObservationInput): {
    observation: MemoryObservation;
    created: boolean;
  } {
    const contentHash = observationHash(input);
    const existing = this.db
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS} FROM mem_observations
         WHERE scope = ? AND COALESCE(source_id, '') = ? AND content_hash = ?`,
      )
      .get(input.scope, input.sourceId ?? '', contentHash) as unknown as RawObservation | undefined;
    if (existing) {
      return { observation: mapObservation(existing), created: false };
    }

    const id = randomUUID();
    const now = Date.now();
    const sensitivity = input.sensitivity ?? 'normal';
    this.db
      .prepare(
        `INSERT INTO mem_observations
           (id, scope, end_id, session_id, run_id, source_id, kind, type, title, subtitle,
            facts_json, narrative, concepts_json, files_read_json, files_modified_json,
            evidence_json, content_hash, sensitivity, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.endId,
        input.sessionId,
        input.runId,
        input.sourceId,
        input.kind,
        input.type,
        input.title,
        input.subtitle ?? null,
        JSON.stringify(input.facts ?? []),
        input.narrative ?? null,
        JSON.stringify(input.concepts ?? []),
        JSON.stringify(input.filesRead ?? []),
        JSON.stringify(input.filesModified ?? []),
        JSON.stringify(input.evidence ?? []),
        contentHash,
        sensitivity,
        now,
        now,
      );
    if (sensitivity !== 'secret') {
      this.indexSearch({
        scope: input.scope,
        endId: input.endId,
        kind: 'observation',
        refId: id,
        authority: null,
        text: [
          input.title,
          input.subtitle ?? '',
          ...(input.facts ?? []),
          input.narrative ?? '',
          ...(input.filesRead ?? []),
          ...(input.filesModified ?? []),
        ].join('\n'),
      });
    }
    return { observation: this.getObservation(id)!, created: true };
  }

  findObservationForSource(
    scope: MemoryScope,
    sourceId: string,
  ): MemoryObservation | undefined {
    const row = this.db
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS} FROM mem_observations
         WHERE scope = ? AND source_id = ? AND status = 'active'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(scope, sourceId) as unknown as RawObservation | undefined;
    return row ? mapObservation(row) : undefined;
  }

  /** Replace the mechanical baseline for one source with the LLM-compressed one. */
  replaceObservationsForSource(scope: MemoryScope, sourceId: string): void {
    const rows = this.db
      .prepare(`SELECT id FROM mem_observations WHERE scope = ? AND source_id = ?`)
      .all(scope, sourceId) as unknown as { id: string }[];
    for (const row of rows) {
      this.db.prepare(`DELETE FROM mem_search WHERE kind = 'observation' AND ref_id = ?`).run(row.id);
    }
    this.db
      .prepare(`DELETE FROM mem_observations WHERE scope = ? AND source_id = ?`)
      .run(scope, sourceId);
  }

  getObservation(id: string): MemoryObservation | undefined {
    const row = this.db
      .prepare(`SELECT ${OBSERVATION_COLUMNS} FROM mem_observations WHERE id = ?`)
      .get(id) as unknown as RawObservation | undefined;
    return row ? mapObservation(row) : undefined;
  }

  listObservationsForSession(
    scope: MemoryScope,
    sessionId: string,
    limit = 50,
  ): MemoryObservation[] {
    const rows = this.db
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS} FROM mem_observations
         WHERE scope = ? AND session_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(scope, sessionId, limit) as unknown as RawObservation[];
    return rows.map(mapObservation);
  }

  listObservations(scope: MemoryScope, limit = 50): MemoryObservation[] {
    const rows = this.db
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS} FROM mem_observations
         WHERE scope = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(scope, limit) as unknown as RawObservation[];
    return rows.map(mapObservation);
  }

  upsertSessionSummary(input: UpsertSessionSummaryInput): MemorySessionSummary {
    const existing = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM mem_session_summaries
         WHERE session_id = ? AND COALESCE(run_id, '') = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.sessionId, input.runId ?? '') as unknown as RawSummary | undefined;
    const sensitivity = input.sensitivity ?? 'normal';
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? Date.now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE mem_session_summaries SET
             scope = ?, end_id = ?, request = ?, investigated = ?, learned = ?,
             completed = ?, next_steps = ?, notes = ?, files_read_json = ?,
             files_edited_json = ?, sensitivity = ?
           WHERE id = ?`,
        )
        .run(
          input.scope,
          input.endId,
          input.request,
          input.investigated ?? '',
          input.learned ?? '',
          input.completed ?? '',
          input.nextSteps ?? '',
          input.notes ?? null,
          JSON.stringify(input.filesRead ?? []),
          JSON.stringify(input.filesEdited ?? []),
          sensitivity,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO mem_session_summaries
             (id, scope, end_id, session_id, run_id, request, investigated, learned,
              completed, next_steps, notes, files_read_json, files_edited_json,
              sensitivity, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.scope,
          input.endId,
          input.sessionId,
          input.runId,
          input.request,
          input.investigated ?? '',
          input.learned ?? '',
          input.completed ?? '',
          input.nextSteps ?? '',
          input.notes ?? null,
          JSON.stringify(input.filesRead ?? []),
          JSON.stringify(input.filesEdited ?? []),
          sensitivity,
          createdAt,
        );
    }
    if (sensitivity !== 'secret') {
      this.indexSearch({
        scope: input.scope,
        endId: input.endId,
        kind: 'summary',
        refId: id,
        authority: null,
        text: [input.request, input.investigated, input.learned, input.completed, input.nextSteps]
          .filter((part): part is string => Boolean(part))
          .join('\n'),
      });
    }
    return this.getSessionSummary(id)!;
  }

  getSessionSummary(id: string): MemorySessionSummary | undefined {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM mem_session_summaries WHERE id = ?`)
      .get(id) as unknown as RawSummary | undefined;
    return row ? mapSummary(row) : undefined;
  }

  listSessionSummaries(scope: MemoryScope, sessionId?: string, limit = 50): MemorySessionSummary[] {
    if (sessionId) {
      return (
        this.db
          .prepare(
            `SELECT ${SUMMARY_COLUMNS} FROM mem_session_summaries
             WHERE scope = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(scope, sessionId, limit) as unknown as RawSummary[]
      ).map(mapSummary);
    }
    return (
      this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM mem_session_summaries
           WHERE scope = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(scope, limit) as unknown as RawSummary[]
    ).map(mapSummary);
  }

  /** nextSteps becomes an open follow-up candidate; duplicates stay collapsed. */
  upsertLoopCandidate(input: {
    scope: MemoryScope;
    endId: string | null;
    title: string;
    detail?: string | null;
    sourceId?: string | null;
  }): string {
    const existing = this.db
      .prepare(
        `SELECT id FROM mem_loops
         WHERE scope = ? AND title = ? AND status = 'open' LIMIT 1`,
      )
      .get(input.scope, input.title) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mem_loops
           (id, scope, end_id, kind, title, detail, due_at, remind_json, status,
            source_id, created_at, updated_at)
         VALUES (?, ?, ?, 'followup', ?, ?, NULL, '[]', 'open', ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.endId,
        input.title,
        input.detail ?? null,
        input.sourceId ?? null,
        now,
        now,
      );
    return id;
  }

  completeLoop(scope: MemoryScope, id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE mem_loops SET status = 'done', updated_at = ?
         WHERE id = ? AND scope = ? AND status = 'open'`,
      )
      .run(Date.now(), id, scope);
    return Number(result.changes) > 0;
  }

  listOpenLoops(scope: MemoryScope): { id: string; title: string; detail: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, title, detail FROM mem_loops
         WHERE scope = ? AND status = 'open' ORDER BY created_at DESC`,
      )
      .all(scope) as unknown as { id: string; title: string; detail: string | null }[];
  }

  // ---- search (D31) ----

  /**
   * D31 ladder: FTS (>= 3 codepoints) -> LIKE substring -> OR over terms.
   * The trigram tokeniser gives substring semantics for CJK; 1-2 character
   * queries must bypass it because FTS5 rejects short phrases.
   */
  searchMemory(input: SearchMemoryInput): MemorySearchHit[] {
    const query = input.query.trim();
    const scopes = [...new Set(input.scopes)];
    if (query === '' || scopes.length === 0) return [];
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const placeholders = scopes.map(() => '?').join(',');

    if (codepointLength(query) >= 3) {
      const hits = this.searchFts(query, scopes, placeholders, limit);
      if (hits.length > 0) return hits;
    }
    const substring = this.searchLike(query, scopes, placeholders, limit);
    if (substring.length > 0) return substring;

    const terms = query.split(/\s+/).filter(Boolean);
    if (terms.length <= 1) return [];
    return this.searchTerms(terms, scopes, placeholders, limit);
  }

  private searchFts(
    query: string,
    scopes: readonly MemoryScope[],
    placeholders: string,
    limit: number,
  ): MemorySearchHit[] {
    try {
      const phrase = `"${query.replace(/"/g, '""')}"`;
      const rows = this.db
        .prepare(
          `SELECT scope, end_id AS endId, kind, ref_id AS refId, authority,
                  document_id AS documentId, chunk_no AS chunkNo, text,
                  bm25(mem_search) AS rank
           FROM mem_search
           WHERE mem_search MATCH ? AND scope IN (${placeholders})
           ORDER BY rank LIMIT ?`,
        )
        .all(phrase, ...scopes, limit * 3) as unknown as RawSearchRow[];
      return dedupeHits(
        rows.map((row) => ({
          ...row,
          score: -Number(row.rank ?? 0),
        })),
      ).slice(0, limit);
    } catch {
      return [];
    }
  }

  private searchLike(
    query: string,
    scopes: readonly MemoryScope[],
    placeholders: string,
    limit: number,
  ): MemorySearchHit[] {
    const pattern = `%${escapeLike(query)}%`;
    const rows = this.db
      .prepare(
        `SELECT scope, end_id AS endId, kind, ref_id AS refId, authority,
                document_id AS documentId, chunk_no AS chunkNo, text
         FROM mem_search
         WHERE text LIKE ? ESCAPE '\\' AND scope IN (${placeholders})
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(pattern, ...scopes, limit) as unknown as RawSearchRow[];
    return rows.map((row) => ({ ...row, score: 1 }));
  }

  private searchTerms(
    terms: readonly string[],
    scopes: readonly MemoryScope[],
    placeholders: string,
    limit: number,
  ): MemorySearchHit[] {
    const conditions = terms.map(() => `text LIKE ? ESCAPE '\\'`).join(' OR ');
    const patterns = terms.map((term) => `%${escapeLike(term)}%`);
    const rows = this.db
      .prepare(
        `SELECT scope, end_id AS endId, kind, ref_id AS refId, authority,
                document_id AS documentId, chunk_no AS chunkNo, text
         FROM mem_search
         WHERE (${conditions}) AND scope IN (${placeholders})
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...patterns, ...scopes, limit * 5) as unknown as RawSearchRow[];
    const scored = rows.map((row) => {
      const haystack = row.text.toLowerCase();
      const hits = terms.reduce(
        (total, term) => total + countOccurrences(haystack, term.toLowerCase()),
        0,
      );
      return { ...row, score: hits };
    });
    scored.sort((a, b) => b.score - a.score);
    return dedupeHits(scored).slice(0, limit);
  }

  private indexSearch(input: {
    scope: MemoryScope;
    endId: string | null;
    kind: string;
    refId: string;
    authority: string | null;
    documentId?: string | null;
    chunkNo?: number | null;
    text: string;
  }): void {
    // Documents insert one row per chunk; the caller clears the whole document
    // before inserting, so deleting by ref_id here would drop earlier chunks.
    if (input.kind !== 'document') {
      this.db
        .prepare(`DELETE FROM mem_search WHERE kind = ? AND ref_id = ?`)
        .run(input.kind, input.refId);
    }
    if (input.text.trim() === '') return;
    this.db
      .prepare(
        `INSERT INTO mem_search
           (scope, end_id, kind, ref_id, document_id, chunk_no, authority, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope,
        input.endId,
        input.kind,
        input.refId,
        input.documentId ?? null,
        input.chunkNo ?? null,
        input.authority,
        input.text,
      );
  }

  private refreshClaimIndex(claim: MemoryClaim): void {
    if (claim.sensitivity === 'secret') {
      this.db.prepare(`DELETE FROM mem_search WHERE kind = 'claim' AND ref_id = ?`).run(claim.id);
      return;
    }
    this.indexSearch({
      scope: claim.scope,
      endId: claim.endId,
      kind: 'claim',
      refId: claim.id,
      authority: claim.authority,
      text: `${claim.predicate} ${claim.objectText ?? ''} ${claim.summary}`.trim(),
    });
  }

  /** One-time upgrade for databases written before mem_search existed. */
  private backfillSearchIndex(): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM mem_search`).get() as { n: number };
    if (Number(row.n) > 0) return;
    const claims = this.db
      .prepare(`SELECT ${CLAIM_COLUMNS} FROM mem_claims WHERE sensitivity <> 'secret'`)
      .all() as unknown as RawClaim[];
    for (const claim of claims) this.refreshClaimIndex(mapClaim(claim));
    const sources = this.db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM mem_sources WHERE sensitivity <> 'secret'`)
      .all() as unknown as MemorySource[];
    for (const source of sources) {
      this.indexSearch({
        scope: source.scope,
        endId: source.endId,
        kind: 'source',
        refId: source.id,
        authority: null,
        text: source.content,
      });
    }
  }

  private findSourceByKey(input: CreateSourceInput, contentHash: string): MemorySource | undefined {
    return this.db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM mem_sources
         WHERE scope = ? AND COALESCE(end_id, '') = ? AND COALESCE(session_id, '') = ?
           AND COALESCE(source_table, '') = ?
           AND COALESCE(CAST(message_id AS TEXT), content_hash) = ?`,
      )
      .get(
        input.scope,
        input.endId ?? '',
        input.sessionId ?? '',
        input.sourceTable ?? '',
        input.messageId !== null && input.messageId !== undefined ? String(input.messageId) : contentHash,
      ) as unknown as MemorySource | undefined;
  }

  private findClaimByDedup(input: CreateClaimInput): MemoryClaim | undefined {
    if (!input.dedupKey) return undefined;
    const row = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM mem_claims
         WHERE scope = ? AND COALESCE(end_id, '') = ? AND dedup_key = ? AND status = 'active'
         ORDER BY (authority = 'user_confirmed') DESC, updated_at DESC
         LIMIT 1`,
      )
      .get(input.scope, input.endId ?? '', input.dedupKey) as unknown as RawClaim | undefined;
    return row ? mapClaim(row) : undefined;
  }
}

export type MemorySearchKind = 'source' | 'claim' | 'observation' | 'summary' | 'document';

export interface MemorySearchHit {
  kind: MemorySearchKind;
  refId: string;
  scope: MemoryScope;
  endId: string | null;
  authority: string | null;
  text: string;
  score: number;
  documentId: string | null;
  chunkNo: number | null;
}

export interface SearchMemoryInput {
  scopes: readonly MemoryScope[];
  query: string;
  limit?: number;
}

export interface ClaimDuplicateRow {
  id: string;
  claimId: string;
  duplicateOf: string;
  scope: MemoryScope;
  score: number;
  method: string;
  status: string;
}

interface RawSearchRow {
  scope: MemoryScope;
  endId: string | null;
  kind: MemorySearchKind;
  refId: string;
  authority: string | null;
  documentId: string | null;
  chunkNo: number | null;
  text: string;
  score?: number;
  rank?: number;
}

function dedupeHits(rows: readonly RawSearchRow[]): MemorySearchHit[] {
  const seen = new Set<string>();
  const hits: MemorySearchHit[] = [];
  for (const row of rows) {
    const key = `${row.kind}:${row.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      kind: row.kind,
      refId: row.refId,
      scope: row.scope,
      endId: row.endId,
      authority: row.authority,
      text: row.text,
      score: Number(row.score ?? 0),
      documentId: row.documentId,
      chunkNo: row.chunkNo,
    });
  }
  return hits;
}

function codepointLength(value: string): number {
  return Array.from(value).length;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

interface RawObservation extends Omit<MemoryObservation, 'facts' | 'concepts' | 'filesRead' | 'filesModified' | 'evidence'> {
  factsJson: string;
  conceptsJson: string;
  filesReadJson: string;
  filesModifiedJson: string;
  evidenceJson: string;
}

function mapObservation(row: RawObservation): MemoryObservation {
  return {
    ...row,
    facts: parseStringArray(row.factsJson),
    concepts: parseStringArray(row.conceptsJson),
    filesRead: parseStringArray(row.filesReadJson),
    filesModified: parseStringArray(row.filesModifiedJson),
    evidence: parseEvidenceArray(row.evidenceJson),
  };
}

function parseEvidenceArray(value: string): { runId: string; seq: number }[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { runId: string; seq: number } =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { runId?: unknown }).runId === 'string' &&
        typeof (item as { seq?: unknown }).seq === 'number',
    );
  } catch {
    return [];
  }
}

interface RawSummary extends Omit<MemorySessionSummary, 'filesRead' | 'filesEdited'> {
  filesReadJson: string;
  filesEditedJson: string;
}

function mapSummary(row: RawSummary): MemorySessionSummary {
  return {
    ...row,
    filesRead: parseStringArray(row.filesReadJson),
    filesEdited: parseStringArray(row.filesEditedJson),
  };
}

export function observationHash(input: UpsertObservationInput): string {
  return hashContent(
    JSON.stringify({
      type: input.type,
      title: input.title,
      subtitle: input.subtitle ?? null,
      facts: input.facts ?? [],
      narrative: input.narrative ?? null,
      filesRead: input.filesRead ?? [],
      filesModified: input.filesModified ?? [],
    }),
  );
}

interface RawEntity extends Omit<MemoryEntity, 'aliases'> {
  aliasesJson: string;
}

function mapEntity(row: RawEntity): MemoryEntity {
  return { ...row, aliases: parseStringArray(row.aliasesJson) };
}

function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

interface RawDocument extends Omit<MemoryDocument, 'tags'> {
  tagsJson: string;
}

function mapDocument(row: RawDocument): MemoryDocument {
  return {
    ...row,
    tags: parseStringArray(row.tagsJson),
  };
}

/**
 * Chunk by headings and paragraphs, then hard-split any oversized block.
 * 2000 characters is roughly the 500-token cap from the design notes.
 */
export function chunkDocument(body: string, title: string, summary: string, maxChars = 2000): string[] {
  const text = body.replace(/\r\n/g, '\n').trim();
  if (text === '') {
    const fallback = `${title}\n${summary}`.trim();
    return [fallback === '' ? title : fallback];
  }
  const blocks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s/.test(line);
    if (heading && current.trim() !== '') {
      blocks.push(current.trim());
      current = '';
    }
    current += `${line}\n`;
    if (current.length >= maxChars) {
      blocks.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') blocks.push(current.trim());

  const chunks: string[] = [];
  for (const block of blocks) {
    for (let start = 0; start < block.length; start += maxChars) {
      chunks.push(block.slice(start, start + maxChars));
    }
  }
  return chunks.length === 0 ? [title] : chunks;
}

interface RawClaim extends Omit<MemoryClaim, 'reinforcementDates'> {
  reinforcementDates: string;
}

function mapClaim(row: RawClaim): MemoryClaim {
  return {
    ...row,
    reinforcementDates: parseStringArray(row.reinforcementDates),
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeObject(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** Latin words + CJK bigrams; used only for Tier-1 candidate scoring. */
function tokenizeForDedup(value: string): Set<string> {
  const text = value.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) tokens.add(match[0]);
  for (const sequence of text.match(/[㐀-鿿]+/g) ?? []) {
    const chars = Array.from(sequence);
    if (chars.length === 1) tokens.add(chars[0]!);
    for (let index = 0; index + 2 <= chars.length; index += 1) {
      tokens.add(chars.slice(index, index + 2).join(''));
    }
  }
  return tokens;
}

/** CRLF/NFKC normalization keeps the dedup key stable across editors. */
export function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex')}`;
}
