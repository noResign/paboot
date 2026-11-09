import fs from 'node:fs';
import { resolveDocumentFile } from '../knowledge/paths.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { MemoryStore } from './store.js';

export interface KnowledgeSyncResult {
  indexed: number;
  removed: number;
}

/**
 * K2: mirror the file-backed knowledge catalogue into memory.db.
 *
 * Files and `.meta.json` remain the source of truth; `mem_documents`,
 * `mem_document_chunks` and `mem_search` are a disposable index. Re-running is
 * idempotent, and a missing file removes its mirror instead of leaving stale
 * results behind. The body never enters memory.db.
 */
export class MemoryKnowledgeIndexer {
  constructor(
    private readonly memory: MemoryStore,
    private readonly knowledge: KnowledgeStore,
  ) {}

  syncWorkspace(workspaceId: string): KnowledgeSyncResult {
    const scope = `workspace:${workspaceId}` as const;
    const root = this.knowledge.root(workspaceId);
    const documents = this.knowledge.list(workspaceId);
    const seen = new Set<string>();
    let indexed = 0;
    let removed = 0;

    for (const document of documents) {
      seen.add(document.id);
      if (document.reviewStatus === 'missing') {
        this.memory.deleteDocument(document.id);
        removed += 1;
        continue;
      }
      let body: string;
      try {
        body = fs.readFileSync(resolveDocumentFile(root, document.path), 'utf8');
      } catch {
        this.memory.deleteDocument(document.id);
        removed += 1;
        continue;
      }
      this.memory.upsertDocument({
        id: document.id,
        scope,
        endId: document.endId,
        kind: document.kind,
        title: document.title,
        summary: document.summary ?? '',
        tags: document.tags,
        path: document.path,
        origin: document.origin,
        authority:
          document.authority === 'curated' && document.reviewStatus === 'confirmed'
            ? 'curated'
            : 'derived',
        reviewStatus: document.reviewStatus,
        sensitivity: 'normal',
        contentHash: document.contentHash,
        lastEditedBy: document.lastEditedBy,
        updatedAt: document.updatedAt,
        body,
      });
      indexed += 1;
    }

    for (const mirrored of this.memory.listDocuments(scope)) {
      if (seen.has(mirrored.id)) continue;
      this.memory.deleteDocument(mirrored.id);
      removed += 1;
    }
    return { indexed, removed };
  }
}
