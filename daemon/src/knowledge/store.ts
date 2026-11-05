import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  allocateDocumentPath,
  assertEndId,
  ensureKnowledgeRoot,
  knowledgeRoot,
  manifestPath,
  resolveDocumentFile,
  scanDocumentFiles,
} from './paths.js';
import { hashContent, inferMetadata, readManifest, summaryFromContent, writeManifest } from './manifest.js';
import {
  KnowledgeError,
  isDocumentKind,
  type CreateKnowledgeInput,
  type DocumentKind,
  type KnowledgeDocument,
  type KnowledgeDocumentDetail,
  type KnowledgeDocumentMeta,
  type ListKnowledgeFilter,
  type UpdateKnowledgeInput,
} from './types.js';
import { createZip, type ZipEntry } from './zip.js';

/**
 * File-backed knowledge store.
 *
 * Every read reconciles first: file hashes are the authority. A discovered file
 * is collected immediately as `confirmed / derived` (unverified); an external
 * content change keeps it included but resets the human-verification marker to
 * `authority=derived`, so pointers carry「未核验」. Reconciliation is idempotent,
 * which also covers duplicate fs events without a watcher.
 */
export class KnowledgeStore {
  constructor(private readonly dataDir: string) {}

  root(workspaceId: string): string {
    return knowledgeRoot(this.dataDir, workspaceId);
  }

  /**
   * Register new files, mark vanished ones missing. External content is
   * included immediately but starts unverified (`authority=derived`); a content
   * change resets verification, because the old human review no longer covers
   * the new text.
   */
  reconcile(workspaceId: string, now: number = Date.now()): KnowledgeDocument[] {
    const root = this.root(workspaceId);
    const manifest = readManifest(root);
    let changed = false;
    const scanned = scanDocumentFiles(root);
    const seen = new Set(scanned);

    for (const relative of scanned) {
      let body: string;
      try {
        body = fs.readFileSync(resolveDocumentFile(root, relative), 'utf8');
      } catch {
        continue;
      }
      const hash = hashContent(body);
      const existing = manifest.documents[relative];
      if (!existing) {
        manifest.documents[relative] = inferMetadata(relative, body, now);
        changed = true;
        continue;
      }
      if (existing.contentHash !== hash) {
        existing.contentHash = hash;
        existing.reviewStatus = 'confirmed';
        existing.authority = 'derived';
        existing.lastEditedBy = 'scan';
        existing.updatedAt = now;
        changed = true;
      } else if (existing.reviewStatus === 'missing') {
        // The file came back; include it again, but the old verification no
        // longer covers whatever it contains now.
        existing.reviewStatus = 'confirmed';
        existing.authority = 'derived';
        existing.updatedAt = now;
        changed = true;
      } else if (existing.reviewStatus !== 'confirmed') {
        // Migrate legacy pending / rejected entries: knowledge is auto-included
        // now, and the review state lives in `authority` (curated = verified).
        existing.reviewStatus = 'confirmed';
        existing.updatedAt = now;
        changed = true;
      }
    }

    for (const [relative, meta] of Object.entries(manifest.documents)) {
      if (seen.has(relative)) continue;
      if (meta.reviewStatus !== 'missing') {
        meta.reviewStatus = 'missing';
        meta.updatedAt = now;
        changed = true;
      }
    }

    if (changed) writeManifest(root, manifest);
    return toDocuments(workspaceId, manifest.documents);
  }

  list(workspaceId: string, filter: ListKnowledgeFilter = {}): KnowledgeDocument[] {
    const root = this.root(workspaceId);
    const query = filter.q?.trim().toLowerCase();
    return this.reconcile(workspaceId).filter((doc) => {
      if (filter.kind && doc.kind !== filter.kind) return false;
      if (filter.status && doc.reviewStatus !== filter.status) return false;
      if (filter.verified !== undefined && (doc.authority === 'curated') !== filter.verified) return false;
      if (filter.endId !== undefined) {
        const wanted = filter.endId === 'workspace' ? null : filter.endId;
        if (doc.endId !== wanted) return false;
      }
      if (query) {
        const body = readBodySafely(resolveDocumentFile(root, doc.path));
        const haystack = [doc.title, doc.summary ?? '', doc.tags.join(' '), body].join('\n').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  /** Workspace-level documents plus those of the given end, confirmed only. */
  confirmed(workspaceId: string, endId: string | null = null): KnowledgeDocument[] {
    const kindPriority = new Map<DocumentKind, number>(
      ['workspace_context', 'convention', 'requirement', 'tech_doc', 'adr', 'decision', 'gotcha', 'contract', 'runbook', 'note']
        .map((kind, index) => [kind as DocumentKind, index]),
    );
    return this.reconcile(workspaceId)
      .filter(
        (doc) =>
          doc.reviewStatus === 'confirmed' &&
          (doc.endId === null || (endId !== null && doc.endId === endId)),
      )
      .sort((a, b) => {
        const priority = (kindPriority.get(a.kind) ?? 99) - (kindPriority.get(b.kind) ?? 99);
        if (priority !== 0) return priority;
        return a.title.localeCompare(b.title);
      });
  }

  get(workspaceId: string, id: string): KnowledgeDocumentDetail {
    const root = this.root(workspaceId);
    const doc = this.reconcile(workspaceId).find((item) => item.id === id);
    if (!doc) throw new KnowledgeError('knowledge document not found', 'knowledge_doc_not_found', 404);
    const absolutePath = resolveDocumentFile(root, doc.path);
    return { ...doc, body: readBodySafely(absolutePath), absolutePath };
  }

  create(workspaceId: string, input: CreateKnowledgeInput): KnowledgeDocumentDetail {
    const title = normalizeTitle(input.title);
    const kind = normalizeKind(input.kind ?? 'note');
    const endId = normalizeEndId(input.endId);
    const tags = normalizeTags(input.tags);
    const body = typeof input.body === 'string' ? input.body : '';
    const summary = normalizeSummary(input.summary) ?? summaryFromContent(body);

    const root = ensureKnowledgeRoot(this.root(workspaceId));
    this.reconcile(workspaceId);
    const relative = allocateDocumentPath(root, title, endId);
    writeFileAtomically(resolveDocumentFile(root, relative), body);

    const now = Date.now();
    const manifest = readManifest(root);
    manifest.documents[relative] = {
      id: `kn_${cryptoRandomId()}`,
      kind,
      title,
      summary,
      endId,
      origin: 'user',
      authority: 'curated',
      reviewStatus: 'confirmed',
      tags,
      contentHash: hashContent(body),
      createdAt: now,
      updatedAt: now,
      lastEditedBy: 'user',
    };
    writeManifest(root, manifest);
    return this.get(workspaceId, manifest.documents[relative]!.id);
  }

  update(workspaceId: string, id: string, input: UpdateKnowledgeInput): KnowledgeDocumentDetail {
    const root = this.root(workspaceId);
    this.reconcile(workspaceId);
    const manifest = readManifest(root);
    const found = findByDocumentId(manifest.documents, id);
    if (!found) throw new KnowledgeError('knowledge document not found', 'knowledge_doc_not_found', 404);
    const [oldRelative, meta] = found;

    const oldAbsolute = resolveDocumentFile(root, oldRelative);
    const oldBody = readBodySafely(oldAbsolute);
    const body = typeof input.body === 'string' ? input.body : oldBody;
    const title = input.title !== undefined ? normalizeTitle(input.title) : meta.title;
    const kind = input.kind !== undefined ? normalizeKind(input.kind) : meta.kind;
    const endId = input.endId !== undefined ? normalizeEndId(input.endId) : meta.endId;
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : meta.tags;
    const summary = input.summary !== undefined
      ? normalizeSummary(input.summary)
      : input.body !== undefined
        ? summaryFromContent(body)
        : meta.summary;

    let relative = oldRelative;
    if (endId !== meta.endId) {
      relative = allocateDocumentPath(root, title, endId);
      writeFileAtomically(resolveDocumentFile(root, relative), body);
      if (fs.existsSync(oldAbsolute)) fs.rmSync(oldAbsolute, { force: true });
      delete manifest.documents[oldRelative];
    } else {
      writeFileAtomically(oldAbsolute, body);
    }

    const updated: KnowledgeDocumentMeta = {
      ...meta,
      kind,
      title,
      summary,
      endId,
      tags,
      contentHash: hashContent(body),
      authority: 'curated',
      reviewStatus: 'confirmed',
      lastEditedBy: 'user',
      updatedAt: Date.now(),
    };
    manifest.documents[relative] = updated;
    writeManifest(root, manifest);
    return this.get(workspaceId, updated.id);
  }

  /** Toggle the human-verification marker without touching the file. */
  verify(workspaceId: string, id: string, verified: boolean): KnowledgeDocument {
    const root = this.root(workspaceId);
    this.reconcile(workspaceId);
    const manifest = readManifest(root);
    const found = findByDocumentId(manifest.documents, id);
    if (!found) throw new KnowledgeError('knowledge document not found', 'knowledge_doc_not_found', 404);
    const [relative, meta] = found;
    const absolute = resolveDocumentFile(root, relative);
    if (!fs.existsSync(absolute)) {
      meta.reviewStatus = 'missing';
      meta.updatedAt = Date.now();
      writeManifest(root, manifest);
      throw new KnowledgeError('knowledge document file is missing', 'knowledge_doc_missing', 409);
    }
    meta.reviewStatus = 'confirmed';
    meta.authority = verified ? 'curated' : 'derived';
    meta.lastEditedBy = 'user';
    meta.updatedAt = Date.now();
    writeManifest(root, manifest);
    return toDocument(workspaceId, relative, meta);
  }

  /** Permanently delete one document (and prune now-empty end directories). */
  remove(workspaceId: string, id: string): void {
    const root = this.root(workspaceId);
    this.reconcile(workspaceId);
    const manifest = readManifest(root);
    const found = findByDocumentId(manifest.documents, id);
    if (!found) throw new KnowledgeError('knowledge document not found', 'knowledge_doc_not_found', 404);
    const [relative] = found;
    const absolute = resolveDocumentFile(root, relative);
    if (fs.existsSync(absolute)) {
      fs.rmSync(absolute, { force: true });
      pruneEmptyParents(root, path.dirname(absolute));
    }
    delete manifest.documents[relative];
    writeManifest(root, manifest);
  }

  /** Workspace deletion removes its knowledge root permanently. */
  deleteWorkspaceData(workspaceId: string): string | null {
    const root = this.root(workspaceId);
    if (!fs.existsSync(root)) return null;
    fs.rmSync(root, { recursive: true, force: true });
    return root;
  }

  /** ZIP of every recognised document plus the manifest. */
  exportZip(workspaceId: string): Buffer {
    const root = this.root(workspaceId);
    this.reconcile(workspaceId);
    const entries: ZipEntry[] = [];
    for (const relative of scanDocumentFiles(root)) {
      const absolute = resolveDocumentFile(root, relative);
      if (!fs.existsSync(absolute)) continue;
      entries.push({ name: relative, data: fs.readFileSync(absolute) });
    }
    const meta = manifestPath(root);
    if (fs.existsSync(meta)) {
      entries.push({ name: 'knowledge/.meta.json', data: fs.readFileSync(meta) });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return createZip(entries);
  }
}

function toDocuments(
  workspaceId: string,
  documents: Record<string, KnowledgeDocumentMeta>,
): KnowledgeDocument[] {
  return Object.entries(documents)
    .map(([relative, meta]) => toDocument(workspaceId, relative, meta))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
}

function toDocument(
  workspaceId: string,
  relative: string,
  meta: KnowledgeDocumentMeta,
): KnowledgeDocument {
  return { ...meta, workspaceId, path: relative };
}

function findByDocumentId(
  documents: Record<string, KnowledgeDocumentMeta>,
  id: string,
): [string, KnowledgeDocumentMeta] | null {
  for (const entry of Object.entries(documents)) {
    if (entry[1].id === id) return entry;
  }
  return null;
}

/** Remove empty `ends/<id>/knowledge` parents after a document is deleted. */
function pruneEmptyParents(root: string, startDir: string): void {
  const resolvedRoot = path.resolve(root);
  let dir = startDir;
  while (dir !== resolvedRoot) {
    const relative = path.relative(resolvedRoot, dir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function readBodySafely(absolute: string): string {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
}

function writeFileAtomically(absolute: string, body: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    fs.renameSync(tmp, absolute);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function normalizeTitle(value: string): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new KnowledgeError('title is required', 'bad_request', 400);
  return title.slice(0, 200);
}

function normalizeKind(value: DocumentKind): DocumentKind {
  if (!isDocumentKind(value)) {
    throw new KnowledgeError(`unknown knowledge kind: ${String(value)}`, 'bad_request', 400);
  }
  return value;
}

function normalizeEndId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new KnowledgeError('endId must be a string', 'bad_request', 400);
  }
  return assertEndId(value.trim());
}

function normalizeTags(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new KnowledgeError('tags must be an array', 'bad_request', 400);
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string') throw new KnowledgeError('tags must be strings', 'bad_request', 400);
    const trimmed = tag.trim().slice(0, 40);
    if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
    if (tags.length >= 20) break;
  }
  return tags;
}

function normalizeSummary(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new KnowledgeError('summary must be a string', 'bad_request', 400);
  return value.trim().slice(0, 500) || null;
}

function cryptoRandomId(): string {
  return randomUUID();
}
