import type { Express, Request, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { Db } from '../db/db.js';
import { filterCaptureText } from '../memory/capture-filter.js';
import { hashContent } from '../memory/store.js';
import { buildLifeBrief } from '../memory/brief.js';
import { configuredMemoryModel, normalizeMemoryModelSelection } from '../memory/model.js';
import {
  MemoryScopeError,
  resolveMemoryScope,
  type ResolvedMemoryScope,
} from '../memory/scope.js';
import type { MemoryClaim, MemoryScope, MemorySessionMode } from '../memory/types.js';
import { log } from '../platform/log.js';
import type {
  MemoryBriefDto,
  MemoryClaimDto,
  MemoryClaimStatusDto,
  MemoryClaimsResponse,
  MemoryEvidenceRelationDto,
  MemorySessionModeDto,
  MemoryStatusDto,
} from '../types/api.js';

function lookupSession(db: Db) {
  return (sessionId: string): { workspaceId: string } | null => {
    const session = db.getSession(sessionId);
    return session?.workspace_id ? { workspaceId: session.workspace_id } : null;
  };
}

function isMemorySessionMode(value: unknown): value is MemorySessionModeDto {
  return value === 'normal' || value === 'no_injection' || value === 'off';
}

function isClaimStatus(value: unknown): value is MemoryClaimStatusDto {
  return value === 'active' || value === 'superseded' || value === 'disputed' || value === 'archived';
}

function scopeDto(scope: ResolvedMemoryScope): MemoryScope {
  return scope.kind === 'user' ? 'user' : `workspace:${scope.workspaceId}`;
}

/**
 * Resolve `sessionId` / `scope`, reject unknown sessions, and keep M0 to life
 * workspaces. `user` is read-only for now (no user claims until M1).
 */
function resolveScope(
  ctx: AppContext,
  req: Request,
  res: Response,
): { resolved: ResolvedMemoryScope; scope: MemoryScope } | null {
  try {
    const resolved = resolveMemoryScope(
      { sessionId: req.query['sessionId'] ?? req.body?.['sessionId'], scope: req.query['scope'] },
      lookupSession(ctx.db),
    );
    if (resolved.kind === 'workspace') {
      const workspace = ctx.db.getWorkspace(resolved.workspaceId!);
      if (!workspace) {
        res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
        return null;
      }
      if (workspace.family !== 'life') {
        res.status(400).json({
          error: 'memory is not enabled for this workspace yet',
          code: 'memory_not_enabled',
        });
        return null;
      }
    }
    return { resolved, scope: scopeDto(resolved) };
  } catch (err) {
    if (err instanceof MemoryScopeError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return null;
    }
    throw err;
  }
}

function toClaimDto(claim: MemoryClaim, ctx: AppContext): MemoryClaimDto {
  return {
    id: claim.id,
    scope: claim.scope,
    endId: claim.endId,
    predicate: claim.predicate,
    objectText: claim.objectText,
    kind: claim.kind,
    summary: claim.summary,
    authority: claim.authority,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    timePrecision: claim.timePrecision,
    confidence: claim.confidence,
    importance: claim.importance,
    sensitivity: claim.sensitivity,
    status: claim.status,
    evidence: ctx.memory!.claimEvidence(claim.id).map((item) => ({
      sourceId: item.sourceId,
      quote: item.quote,
      relation: item.relation as MemoryEvidenceRelationDto,
    })),
    updatedAt: claim.updatedAt,
  };
}

function requireClaim(
  ctx: AppContext,
  req: Request,
  res: Response,
  scope: MemoryScope,
): MemoryClaim | null {
  const claim = ctx.memory!.getClaim(req.params['id']!);
  if (!claim || claim.scope !== scope || claim.sensitivity === 'secret') {
    res.status(404).json({ error: 'claim not found', code: 'claim_not_found' });
    return null;
  }
  return claim;
}

export function registerMemoryRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/memory/brief', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    if (target.scope === 'user') {
      res.json(emptyBrief(target.scope));
      return;
    }
    const brief = buildLifeBrief(ctx.memory!, target.scope);
    if (!brief) {
      res.json(emptyBrief(target.scope));
      return;
    }
    const dto: MemoryBriefDto = {
      scope: brief.scope,
      markdown: brief.markdown,
      charCount: brief.charCount,
      usedClaimIds: brief.usedClaimIds,
      truncated: brief.truncated,
      builtAt: Date.now(),
    };
    res.json(dto);
  });

  app.get('/api/memory/claims', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const status = req.query['status'] ?? 'active';
    if (!isClaimStatus(status)) {
      res.status(400).json({ error: 'invalid claim status', code: 'bad_request' });
      return;
    }
    const claims = ctx.memory!.listClaims(target.scope, status)
      .filter((claim) => claim.sensitivity !== 'secret');
    const dto: MemoryClaimsResponse = { claims: claims.map((claim) => toClaimDto(claim, ctx)) };
    res.json(dto);
  });

  app.get('/api/memory/claims/:id', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const claim = requireClaim(ctx, req, res, target.scope);
    if (!claim) return;
    res.json({ claim: toClaimDto(claim, ctx) });
  });

  app.patch('/api/memory/claims/:id', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const claim = requireClaim(ctx, req, res, target.scope);
    if (!claim) return;

    const summary = typeof req.body?.['summary'] === 'string' ? req.body['summary'].trim() : undefined;
    const objectText =
      typeof req.body?.['objectText'] === 'string' ? req.body['objectText'].trim() : undefined;
    if ((summary === undefined || summary === '') && (objectText === undefined || objectText === '')) {
      res.status(400).json({ error: 'summary or objectText is required', code: 'bad_request' });
      return;
    }
    const corrected = ctx.memory!.correctClaim(claim.id, {
      ...(summary === undefined || summary === '' ? {} : { summary }),
      ...(objectText === undefined || objectText === '' ? {} : { objectText }),
    });
    if (!corrected) {
      res.status(404).json({ error: 'claim not found', code: 'claim_not_found' });
      return;
    }
    ctx.memory!.addFeedback({
      targetType: 'claim',
      targetId: claim.id,
      action: 'corrected',
      sessionId: target.resolved.sessionId,
    });
    res.json({ claim: toClaimDto(corrected, ctx) });
  });

  app.delete('/api/memory/claims/:id', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const claim = requireClaim(ctx, req, res, target.scope);
    if (!claim) return;
    ctx.memory!.forgetClaim(claim.id);
    res.json({ ok: true, id: claim.id });
  });

  app.post('/api/memory/feedback', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const targetId = typeof req.body?.['targetId'] === 'string' ? req.body['targetId'] : null;
    const action = req.body?.['action'];
    if (!targetId || typeof action !== 'string') {
      res.status(400).json({ error: 'targetId and action are required', code: 'bad_request' });
      return;
    }
    const claim = ctx.memory!.getClaim(targetId);
    if (!claim || claim.scope !== target.scope || claim.sensitivity === 'secret') {
      res.status(404).json({ error: 'claim not found', code: 'claim_not_found' });
      return;
    }
    ctx.memory!.addFeedback({
      targetType: 'claim',
      targetId,
      action,
      note: typeof req.body?.['note'] === 'string' ? req.body['note'] : null,
      sessionId: target.resolved.sessionId,
    });
    res.json({ ok: true });
  });

  app.post('/api/memory/remember', (req, res) => {
    const sessionId = typeof req.body?.['sessionId'] === 'string' ? req.body['sessionId'] : null;
    const messageId = Number(req.body?.['messageId']);
    if (!sessionId || !Number.isInteger(messageId)) {
      res.status(400).json({ error: 'sessionId and messageId are required', code: 'bad_request' });
      return;
    }
    const session = ctx.db.getSession(sessionId);
    if (!session?.workspace_id) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const workspace = ctx.db.getWorkspace(session.workspace_id);
    if (!workspace || workspace.family !== 'life') {
      res.status(400).json({ error: 'memory is not enabled for this workspace yet', code: 'memory_not_enabled' });
      return;
    }
    if (session.memory_mode === 'off') {
      res.status(400).json({ error: 'memory is disabled for this session', code: 'memory_disabled' });
      return;
    }
    const message = ctx.db.listMessages(session.id).find((row) => row.id === messageId);
    if (!message) {
      res.status(404).json({ error: 'message not found', code: 'message_not_found' });
      return;
    }
    const content = filterCaptureText(message.content);
    if (content === '') {
      res.status(400).json({ error: 'message has no capturable content', code: 'empty_content' });
      return;
    }
    const ends = ctx.db.listEnds(workspace.id);
    const lifeEnd = ends.find((end) => end.kind === 'life' && end.status === 'active');
    const endId = session.end_id ?? lifeEnd?.id ?? null;
    const scoped = `workspace:${workspace.id}` as const;
    if (ctx.memory!.hasTombstone(scoped, endId, hashContent(content))) {
      res.status(409).json({
        error: 'this content was forgotten and cannot be re-remembered',
        code: 'forgotten_content',
      });
      return;
    }
    const result = ctx.memory!.insertSource({
      scope: scoped,
      workspaceId: workspace.id,
      endId,
      kind: 'manual',
      sourceTable: 'note',
      sessionId: session.id,
      messageId: null,
      occurredAt: message.created_at,
      content,
      meta: { rememberedFromMessageId: message.id },
    });
    ctx.memoryWorker?.kick();
    res.json({ ok: true, sourceId: result.source.id });
  });

  app.get('/api/memory/status', async (req, res) => {
    try {
      const target = resolveScope(ctx, req, res);
      if (!target) return;
      const extractionModel = configuredMemoryModel(
        (key) => ctx.db.getSetting(key),
        ctx.config.memoryModel,
      );
      let modelAvailable = false;
      if (extractionModel && ctx.providers?.list) {
        try {
          modelAvailable = normalizeMemoryModelSelection(
            extractionModel,
            await ctx.providers.list(),
          ) !== null;
        } catch (err) {
          log.warn('memory status: provider catalog unavailable', err);
        }
      }
      const dto: MemoryStatusDto = {
        scope: target.scope,
        pendingSources: ctx.memory!.countSources('pending', target.scope),
        lastConsolidatedAt: numberState(ctx, 'last_consolidated_at'),
        lastSuccessAt: numberState(ctx, 'last_success_at'),
        consecutiveFailures: Number(ctx.memory!.getState('consecutive_failures') ?? 0),
        extractionModel,
        modelAvailable,
        enabled: true,
      };
      res.json(dto);
    } catch (err) {
      log.warn('memory status failed', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'failed to load memory status', code: 'internal_error' });
      }
    }
  });

  app.patch('/api/memory/session', (req, res) => {
    const sessionId = typeof req.body?.['sessionId'] === 'string' ? req.body['sessionId'] : null;
    const mode = req.body?.['mode'];
    if (!sessionId || !isMemorySessionMode(mode)) {
      res.status(400).json({ error: 'sessionId and a valid mode are required', code: 'bad_request' });
      return;
    }
    const session = ctx.db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const workspace = session.workspace_id ? ctx.db.getWorkspace(session.workspace_id) : undefined;
    if (!workspace || workspace.family !== 'life' || session.kind !== 'chat') {
      res.status(400).json({ error: 'memory is not enabled for this workspace yet', code: 'memory_not_enabled' });
      return;
    }
    const previousMode = session.memory_mode;
    ctx.db.setSessionMemoryMode(session.id, mode as MemorySessionMode);
    // Turning off is a hard privacy boundary: anything said while off must not
    // be backfilled when memory is enabled again.
    if (previousMode === 'off' && mode !== 'off') {
      ctx.db.setSessionMemoryCaptureAfterMessageId(session.id, ctx.db.maxMessageId(session.id));
    }
    res.json({ sessionId: session.id, mode });
  });
}

function emptyBrief(scope: MemoryScope): MemoryBriefDto {
  return { scope, markdown: '', charCount: 0, usedClaimIds: [], truncated: false, builtAt: Date.now() };
}

function numberState(ctx: AppContext, key: string): number | null {
  const value = ctx.memory!.getState(key);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
