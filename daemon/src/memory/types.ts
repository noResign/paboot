export type MemoryScope = 'user' | `workspace:${string}`;
export type Sensitivity = 'normal' | 'private' | 'secret';
export type SourceKind = 'message' | 'tool' | 'note' | 'manual' | 'connector';
export type SourceStatus = 'pending' | 'extracted' | 'excluded' | 'skipped';
export type ClaimKind = 'fact' | 'preference' | 'relation' | 'profile';
export type ClaimAuthority = 'derived' | 'user_confirmed';
export type ClaimStatus = 'active' | 'superseded' | 'disputed' | 'archived';
export type EvidenceRelation = 'supports' | 'contradicts' | 'corrects';
export type MemorySessionMode = 'normal' | 'no_injection' | 'off';

/** One captured L0 source row. `contentHash` is always the normalized body hash. */
export interface MemorySource {
  id: string;
  /** SQLite insertion order; used to fetch the preceding turn as context. */
  rowId: number;
  scope: MemoryScope;
  workspaceId: string | null;
  endId: string | null;
  kind: SourceKind;
  sourceTable: 'messages' | 'native_messages' | 'events' | 'note' | 'connector' | null;
  sessionId: string | null;
  runId: string | null;
  messageId: number | null;
  occurredAt: number;
  content: string;
  contentHash: string;
  metaJson: string;
  sensitivity: Sensitivity;
  status: SourceStatus;
  createdAt: number;
}

export interface CreateSourceInput {
  scope: MemoryScope;
  workspaceId?: string | null;
  endId?: string | null;
  kind: SourceKind;
  sourceTable?: MemorySource['sourceTable'];
  sessionId?: string | null;
  runId?: string | null;
  messageId?: number | null;
  occurredAt: number;
  content: string;
  meta?: Record<string, unknown>;
  sensitivity?: Sensitivity;
  status?: SourceStatus;
}

export interface CreateClaimInput {
  id?: string;
  scope: MemoryScope;
  endId?: string | null;
  entityId?: string | null;
  predicate: string;
  objectText?: string | null;
  objectEntityId?: string | null;
  kind: ClaimKind;
  summary: string;
  authority?: ClaimAuthority;
  shareClass?: 'portable' | 'personal' | 'life_only' | null;
  promotedFrom?: string | null;
  validFrom?: number | null;
  validTo?: number | null;
  timePrecision?: 'exact' | 'day' | 'month' | 'year' | 'unknown';
  confidence: number;
  importance: number;
  reinforcementDates?: string[];
  dedupKey?: string | null;
  sensitivity?: Sensitivity;
  status?: ClaimStatus;
  supersededBy?: string | null;
}

export interface ClaimEvidenceInput {
  sourceId: string;
  relation?: EvidenceRelation;
  quote?: string | null;
}

export interface MemoryClaim {
  id: string;
  scope: MemoryScope;
  endId: string | null;
  entityId: string | null;
  predicate: string;
  objectText: string | null;
  objectEntityId: string | null;
  kind: ClaimKind;
  summary: string;
  authority: ClaimAuthority;
  shareClass: 'portable' | 'personal' | 'life_only' | null;
  promotedFrom: string | null;
  validFrom: number | null;
  validTo: number | null;
  timePrecision: 'exact' | 'day' | 'month' | 'year' | 'unknown';
  confidence: number;
  importance: number;
  reinforcementDates: string[];
  dedupKey: string | null;
  sensitivity: Sensitivity;
  status: ClaimStatus;
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
}
