/**
 * Curated knowledge documents (K0).
 *
 * The markdown file is the source of truth; `.meta.json` only carries
 * governance state (kind / review status / hash). Nothing here is persisted in
 * SQLite — K0 deliberately has no memory.db, and K2 later mirrors this manifest
 * into the search index.
 */

export const DOCUMENT_KINDS = [
  'workspace_context',
  'convention',
  'requirement',
  'tech_doc',
  'adr',
  'decision',
  'gotcha',
  'contract',
  'runbook',
  'note',
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_ORIGINS = ['user', 'agent', 'imported'] as const;
export type DocumentOrigin = (typeof DOCUMENT_ORIGINS)[number];

export const DOCUMENT_AUTHORITIES = ['curated', 'derived'] as const;
export type DocumentAuthority = (typeof DOCUMENT_AUTHORITIES)[number];

export const REVIEW_STATUSES = ['pending', 'confirmed', 'rejected', 'missing'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type LastEditedBy = 'user' | 'agent' | 'scan';

export interface KnowledgeDocumentMeta {
  id: string;
  kind: DocumentKind;
  title: string;
  summary: string | null;
  /** `null` means workspace-level; otherwise the owning end. */
  endId: string | null;
  origin: DocumentOrigin;
  authority: DocumentAuthority;
  reviewStatus: ReviewStatus;
  tags: string[];
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  lastEditedBy: LastEditedBy;
}

/** One `.meta.json` for the whole workspace; keys are POSIX relative paths. */
export interface KnowledgeManifest {
  version: 1;
  documents: Record<string, KnowledgeDocumentMeta>;
}

/** A manifest entry joined with its workspace and relative path. */
export interface KnowledgeDocument extends KnowledgeDocumentMeta {
  workspaceId: string;
  /** POSIX path relative to the workspace knowledge root. */
  path: string;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  body: string;
  /** Absolute path the agent can Read; never stored in the manifest. */
  absolutePath: string;
}

export interface CreateKnowledgeInput {
  title: string;
  body: string;
  kind?: DocumentKind;
  endId?: string | null;
  tags?: string[];
  summary?: string | null;
}

export interface UpdateKnowledgeInput {
  title?: string;
  body?: string;
  kind?: DocumentKind;
  endId?: string | null;
  tags?: string[];
  /** `null` clears the summary; omit to keep it. */
  summary?: string | null;
}

export interface ListKnowledgeFilter {
  /** `'workspace'` selects `endId === null`; omit for all. */
  endId?: string;
  kind?: DocumentKind;
  status?: ReviewStatus;
  /** `true` = human-verified (`authority=curated`); `false` = auto-collected. */
  verified?: boolean;
  q?: string;
}

/** Typed failure carrying the HTTP status the route should use. */
export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);
}
