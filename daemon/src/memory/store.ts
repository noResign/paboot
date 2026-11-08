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
  MemoryScope,
  MemorySource,
  SourceStatus,
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
    return { source, created: Number(result.changes) > 0 };
  }

  getSource(id: string): MemorySource | undefined {
    return this.db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM mem_sources WHERE id = ?`)
      .get(id) as unknown as MemorySource | undefined;
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

  // ---- claims ----

  insertClaim(input: CreateClaimInput, evidence: readonly ClaimEvidenceInput[] = []): MemoryClaim {
    // Tier-0: an exact dedup key merges into the existing row instead of
    // creating a second claim. The unique-ish check stays in application code
    // because dedup_key is nullable and the index is not UNIQUE.
    const existing = input.dedupKey ? this.findClaimByDedup(input) : undefined;
    if (existing) {
      this.attachEvidence(existing.id, evidence);
      return existing;
    }

    const id = input.id ?? randomUUID();
    const now = Date.now();
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
    return claim;
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
    return this.getClaim(id);
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
    return this.getClaim(id);
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

/** CRLF/NFKC normalization keeps the dedup key stable across editors. */
export function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex')}`;
}
