import type { Express, Request, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { WorkspaceRow } from '../db/db.js';
import { assertEndId } from '../knowledge/paths.js';
import {
  KnowledgeError,
  isDocumentKind,
  isReviewStatus,
  type CreateKnowledgeInput,
  type DocumentKind,
  type KnowledgeDocument,
  type KnowledgeDocumentDetail,
  type ListKnowledgeFilter,
  type ReviewStatus,
  type UpdateKnowledgeInput,
} from '../knowledge/types.js';
import type {
  KnowledgeDocDetailDto,
  KnowledgeDocDto,
  KnowledgeReviewStatus,
} from '../types/api.js';
import { log } from '../platform/log.js';

/** K2 is derived index state: a failure must not fail the knowledge request. */
function syncKnowledgeIndex(ctx: AppContext, workspaceId: string): void {
  try {
    ctx.knowledgeIndex?.syncWorkspace(workspaceId);
  } catch (err) {
    log.warn(`knowledge index sync failed for workspace ${workspaceId}`, err);
  }
}

function toDocDto(doc: KnowledgeDocument): KnowledgeDocDto {
  return {
    id: doc.id,
    workspaceId: doc.workspaceId,
    endId: doc.endId,
    kind: doc.kind,
    title: doc.title,
    summary: doc.summary,
    tags: [...doc.tags],
    origin: doc.origin,
    authority: doc.authority,
    reviewStatus: doc.reviewStatus as KnowledgeReviewStatus,
    path: doc.path,
    contentHash: doc.contentHash,
    updatedAt: doc.updatedAt,
    lastEditedBy: doc.lastEditedBy,
  };
}

function toDetailDto(doc: KnowledgeDocumentDetail): KnowledgeDocDetailDto {
  return { ...toDocDto(doc), body: doc.body, absolutePath: doc.absolutePath };
}

function sendKnowledgeError(res: Response, err: unknown): void {
  if (err instanceof KnowledgeError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
}

function requireWorkspace(ctx: AppContext, req: Request, res: Response): WorkspaceRow | null {
  const workspace = ctx.db.getWorkspace(req.params.id!);
  if (!workspace) {
    res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
    return null;
  }
  return workspace;
}

function readKind(value: unknown): DocumentKind | undefined {
  if (value === undefined) return undefined;
  if (!isDocumentKind(value)) {
    throw new KnowledgeError(`unknown knowledge kind: ${String(value)}`, 'bad_request', 400);
  }
  return value;
}

function readStatus(value: unknown): ReviewStatus | undefined {
  if (value === undefined) return undefined;
  if (!isReviewStatus(value)) {
    throw new KnowledgeError(`unknown review status: ${String(value)}`, 'bad_request', 400);
  }
  return value;
}

function readEndId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new KnowledgeError('endId must be a string', 'bad_request', 400);
  }
  return assertEndId(value.trim());
}

function readTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new KnowledgeError('tags must be an array of strings', 'bad_request', 400);
  }
  return value as string[];
}

function readSummary(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string') return value;
  throw new KnowledgeError('summary must be a string or null', 'bad_request', 400);
}

function parseCreate(raw: unknown): CreateKnowledgeInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  return {
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    kind: readKind(body.kind),
    endId: readEndId(body.endId),
    tags: readTags(body.tags),
    summary: readSummary(body.summary),
  };
}

function parseUpdate(raw: unknown): UpdateKnowledgeInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const input: UpdateKnowledgeInput = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') {
      throw new KnowledgeError('title must be a string', 'bad_request', 400);
    }
    input.title = body.title;
  }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') {
      throw new KnowledgeError('body must be a string', 'bad_request', 400);
    }
    input.body = body.body;
  }
  const kind = readKind(body.kind);
  if (kind !== undefined) input.kind = kind;
  const endId = readEndId(body.endId);
  if (endId !== undefined) input.endId = endId;
  const tags = readTags(body.tags);
  if (tags !== undefined) input.tags = tags;
  const summary = readSummary(body.summary);
  if (summary !== undefined) input.summary = summary;
  return input;
}

/**
 * Curated knowledge API.
 *
 * Reads are open to every authenticated role (agent token included); the
 * `requireRolePolicy` middleware already turns every non-GET public write into
 * a 403 for agent / server tokens, so write / verify / delete are operator-only
 * without extra checks here. Writes record metadata-only audit entries; the
 * body and title may contain sensitive text and are never logged.
 */
export function registerKnowledgeRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/workspaces/:id/knowledge/export', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      const zip = ctx.knowledge.exportZip(workspace.id);
      const filename = `knowledge-${workspace.id.replace(/[^A-Za-z0-9_-]/g, '_')}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(zip);
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });

  app.get('/api/workspaces/:id/knowledge', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      const filter: ListKnowledgeFilter = {};
      if (typeof req.query.endId === 'string') {
        filter.endId = req.query.endId === 'workspace'
          ? 'workspace'
          : assertEndId(req.query.endId);
      }
      const kind = readKind(req.query.kind);
      if (kind !== undefined) filter.kind = kind;
      const status = readStatus(req.query.status);
      if (status !== undefined) filter.status = status;
      if (req.query.verified !== undefined) {
        const raw = req.query.verified;
        if (raw === '1' || raw === 'true') filter.verified = true;
        else if (raw === '0' || raw === 'false') filter.verified = false;
        else throw new KnowledgeError('verified must be true or false', 'bad_request', 400);
      }
      if (typeof req.query.q === 'string' && req.query.q.trim()) filter.q = req.query.q;
      const documents = ctx.knowledge.list(workspace.id, filter);
      // Listing reconciles external file changes; mirror them before answering
      // so a follow-up memory search sees the same catalogue.
      syncKnowledgeIndex(ctx, workspace.id);
      res.json({ documents: documents.map(toDocDto) });
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });

  app.get('/api/workspaces/:id/knowledge/:kid', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      res.json({ document: toDetailDto(ctx.knowledge.get(workspace.id, req.params.kid!)) });
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });

  app.post('/api/workspaces/:id/knowledge', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      const document = ctx.knowledge.create(workspace.id, parseCreate(req.body));
      syncKnowledgeIndex(ctx, workspace.id);
      ctx.db.audit(
        'knowledge_create',
        JSON.stringify({ workspaceId: workspace.id, id: document.id, path: document.path }),
      );
      res.status(201).json({ document: toDetailDto(document) });
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });

  app.patch('/api/workspaces/:id/knowledge/:kid', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      const document = ctx.knowledge.update(workspace.id, req.params.kid!, parseUpdate(req.body));
      syncKnowledgeIndex(ctx, workspace.id);
      ctx.db.audit(
        'knowledge_update',
        JSON.stringify({ workspaceId: workspace.id, id: document.id, path: document.path }),
      );
      res.json({ document: toDetailDto(document) });
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });

  app.post('/api/workspaces/:id/knowledge/:kid/verify', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      const raw = (req.body ?? {}) as { verified?: unknown };
      if (typeof raw.verified !== 'boolean') {
        throw new KnowledgeError('verified must be a boolean', 'bad_request', 400);
      }
      const document = ctx.knowledge.verify(workspace.id, req.params.kid!, raw.verified);
      syncKnowledgeIndex(ctx, workspace.id);
      ctx.db.audit(
        'knowledge_verify',
        JSON.stringify({
          workspaceId: workspace.id,
          id: document.id,
          path: document.path,
          verified: raw.verified,
        }),
      );
      res.json({ document: toDocDto(document) });
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });

  app.delete('/api/workspaces/:id/knowledge/:kid', (req, res) => {
    const workspace = requireWorkspace(ctx, req, res);
    if (!workspace) return;
    try {
      const id = req.params.kid!;
      ctx.knowledge.remove(workspace.id, id);
      syncKnowledgeIndex(ctx, workspace.id);
      ctx.db.audit('knowledge_delete', JSON.stringify({ workspaceId: workspace.id, id }));
      res.json({ ok: true, id });
    } catch (err) {
      sendKnowledgeError(res, err);
    }
  });
}
