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

export type ObservationKind = 'tool' | 'turn' | 'manual';
export type ObservationType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'change'
  | 'discovery'
  | 'decision'
  | 'security_alert'
  | 'security_note'
  | 'sensitive';

/** L0.5 compressed run/event observation. */
export interface MemoryObservation {
  id: string;
  scope: MemoryScope;
  endId: string | null;
  sessionId: string | null;
  runId: string | null;
  sourceId: string | null;
  kind: ObservationKind;
  type: ObservationType;
  title: string;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  evidence: { runId: string; seq: number }[];
  contentHash: string;
  sensitivity: Sensitivity;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertObservationInput {
  scope: MemoryScope;
  endId: string | null;
  sessionId: string | null;
  runId: string | null;
  sourceId: string | null;
  kind: ObservationKind;
  type: ObservationType;
  title: string;
  subtitle?: string | null;
  facts?: string[];
  narrative?: string | null;
  concepts?: string[];
  filesRead?: string[];
  filesModified?: string[];
  evidence?: { runId: string; seq: number }[];
  sensitivity?: Sensitivity;
}

export interface MemorySessionSummary {
  id: string;
  scope: MemoryScope;
  endId: string | null;
  sessionId: string;
  runId: string | null;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
  notes: string | null;
  filesRead: string[];
  filesEdited: string[];
  sensitivity: Sensitivity;
  createdAt: number;
}

export interface UpsertSessionSummaryInput {
  scope: MemoryScope;
  endId: string | null;
  sessionId: string;
  runId: string | null;
  request: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  nextSteps?: string;
  notes?: string | null;
  filesRead?: string[];
  filesEdited?: string[];
  sensitivity?: Sensitivity;
}

/** K2 mirror of one curated knowledge document (body stays in the file). */
export interface MemoryDocument {
  id: string;
  scope: MemoryScope;
  endId: string | null;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  path: string;
  origin: string;
  authority: 'curated' | 'derived';
  weight: number;
  reviewStatus: 'pending' | 'confirmed' | 'rejected' | 'missing';
  extractable: number;
  sensitivity: Sensitivity;
  contentHash: string;
  lastEditedBy: string;
  updatedAt: number;
}

export interface UpsertDocumentInput extends Omit<MemoryDocument, 'tags' | 'weight' | 'extractable'> {
  tags?: string[];
  weight?: number;
  extractable?: number;
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
