import type { Express, Request, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { Db, WorkspaceRow } from '../db/db.js';
import { filterCaptureText } from '../memory/capture-filter.js';
import { hashContent } from '../memory/store.js';
import { buildMemoryBrief } from '../memory/brief.js';
import { configuredMemoryModel, normalizeMemoryModelSelection } from '../memory/model.js';
import {
  claimAllowed,
  resolveReadPolicy,
  scopeAllowsSensitivity,
  userReadPolicy,
  type MemoryReadPolicy,
} from '../memory/read-policy.js';
import {
  MemoryScopeError,
  resolveMemoryScope,
  type ResolvedMemoryScope,
} from '../memory/scope.js';
import {
  effectiveMemorySettings,
  isMemoryEnabled,
  isMemoryProfileMode,
  type MemoryProfileMode,
} from '../memory/settings.js';
import type { MemoryClaim, MemoryScope, MemorySessionMode } from '../memory/types.js';
import { log } from '../platform/log.js';
import type {
  MemoryBriefDto,
  MemoryClaimDto,
  MemoryClaimStatusDto,
  MemoryClaimsResponse,
  MemoryEvidenceRelationDto,
  MemorySearchResponse,
  MemorySessionModeDto,
  MemorySourceDto,
  MemoryStatusDto,
  MemoryTimelineItemDto,
  MemoryTimelineResponse,
  WorkspaceMemoryDto,
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

interface MemoryTarget {
  resolved: ResolvedMemoryScope;
  scope: MemoryScope;
  workspace: WorkspaceRow | null;
  policy: MemoryReadPolicy;
}

/**
 * Resolve `sessionId` / `scope` and apply the workspace switch + read policy.
 * Dev workspaces are readable once enabled; life composes `user` + life +
 * readable dev workspaces. Explicit `scope=user` is operator-level read-only.
 */
function resolveScope(ctx: AppContext, req: Request, res: Response): MemoryTarget | null {
  try {
    const resolved = resolveMemoryScope(
      { sessionId: req.query['sessionId'] ?? req.body?.['sessionId'], scope: req.query['scope'] },
      lookupSession(ctx.db),
    );
    if (resolved.kind === 'user') {
      return { resolved, scope: 'user', workspace: null, policy: userReadPolicy() };
    }
    const workspace = ctx.db.getWorkspace(resolved.workspaceId!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return null;
    }
    const settings = ctx.db.getMemorySettings(workspace.id);
    if (!isMemoryEnabled(workspace, settings)) {
      res.status(400).json({
        error: 'memory is not enabled for this workspace',
        code: 'memory_not_enabled',
      });
      return null;
    }
    const policy = resolveReadPolicy({
      workspace,
      workspaces: ctx.db.listWorkspaces(),
      getSettings: (workspaceId) => ctx.db.getMemorySettings(workspaceId),
    });
    return { resolved, scope: scopeDto(resolved), workspace, policy };
  } catch (err) {
    if (err instanceof MemoryScopeError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return null;
    }
    throw err;
  }
}

function memoryClaimsFor(
  ctx: AppContext,
  target: MemoryTarget,
  status: MemoryClaimStatusDto,
): MemoryClaim[] {
  const byId = new Map<string, MemoryClaim>();
  for (const readScope of target.policy.scopes) {
    for (const claim of ctx.memory!.listClaims(readScope.scope, status)) {
      if (claimAllowed(claim, target.policy)) byId.set(claim.id, claim);
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Mutations stay within the caller's own scope; cross-read dev claims are read-only. */
function requireWritableClaim(
  ctx: AppContext,
  req: Request,
  res: Response,
  target: MemoryTarget,
): MemoryClaim | null {
  const claim = ctx.memory!.getClaim(req.params['id']!);
  if (!claim || claim.scope !== target.scope || claim.sensitivity === 'secret') {
    res.status(404).json({ error: 'claim not found', code: 'claim_not_found' });
    return null;
  }
  return claim;
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
    shareClass: claim.shareClass,
    promotedFrom: claim.promotedFrom,
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

function requireReadableClaim(
  ctx: AppContext,
  req: Request,
  res: Response,
  target: MemoryTarget,
): MemoryClaim | null {
  const claim = ctx.memory!.getClaim(req.params['id']!);
  if (!claim || !claimAllowed(claim, target.policy)) {
    res.status(404).json({ error: 'claim not found', code: 'claim_not_found' });
    return null;
  }
  return claim;
}

function resolveInternalTarget(ctx: AppContext, req: Request, res: Response): MemoryTarget | null {
  const raw = req.query['runId'] ?? req.body?.['runId'];
  const runId = typeof raw === 'string' ? raw : '';
  const run = runId ? ctx.db.getRun(runId) : undefined;
  if (!run) {
    res.status(404).json({ error: 'run not found', code: 'run_not_found' });
    return null;
  }
  const session = ctx.db.getSession(run.session_id);
  const workspace = session?.workspace_id ? ctx.db.getWorkspace(session.workspace_id) : undefined;
  if (!session || !workspace) {
    res.status(404).json({ error: 'session not found', code: 'session_not_found' });
    return null;
  }
  const settings = ctx.db.getMemorySettings(workspace.id);
  if (!isMemoryEnabled(workspace, settings)) {
    res.status(400).json({ error: 'memory is not enabled for this workspace', code: 'memory_not_enabled' });
    return null;
  }
  return {
    resolved: {
      kind: 'workspace',
      workspaceId: workspace.id,
      sessionId: session.id,
    },
    scope: `workspace:${workspace.id}`,
    workspace,
    policy: resolveReadPolicy({
      workspace,
      workspaces: ctx.db.listWorkspaces(),
      getSettings: (workspaceId) => ctx.db.getMemorySettings(workspaceId),
    }),
  };
}

function internalSearchHits(
  ctx: AppContext,
  target: MemoryTarget,
  query: string,
  limit: number,
  files: string[],
): MemorySearchResponse {
  const hits = ctx.memory!.searchMemory({
    scopes: target.policy.scopes.map((item) => item.scope),
    query,
    limit: Math.max(limit * 3, limit),
  });
  const out: MemorySearchResponse = { hits: [] };
  const fileMatches = (paths: string[]): boolean =>
    files.length === 0 ||
    files.some((needle) =>
      paths.some((pathValue) => pathValue.toLowerCase().includes(needle.toLowerCase())),
    );
  for (const hit of hits) {
    if (out.hits.length >= limit) break;
    if (files.length > 0 && hit.kind !== 'observation' && hit.kind !== 'summary') continue;
    if (hit.kind === 'claim') {
      const claim = ctx.memory!.getClaim(hit.refId);
      if (!claim || claim.status !== 'active' || !claimAllowed(claim, target.policy)) continue;
      out.hits.push({
        kind: 'claim',
        id: claim.id,
        scope: claim.scope,
        endId: claim.endId,
        title: claim.summary,
        snippet: compact(claim.summary, 240),
        score: hit.score,
      });
    } else if (hit.kind === 'observation') {
      const observation = ctx.memory!.getObservation(hit.refId);
      const paths = observation
        ? [...observation.filesRead, ...observation.filesModified]
        : [];
      if (
        !observation ||
        observation.status !== 'active' ||
        !scopeAllowsSensitivity(target.policy, observation.scope, observation.sensitivity) ||
        !fileMatches(paths)
      ) {
        continue;
      }
      out.hits.push({
        kind: 'observation',
        id: observation.id,
        scope: observation.scope,
        endId: observation.endId,
        title: observation.title,
        snippet: compact(observation.subtitle ?? observation.narrative ?? observation.title, 240),
        score: hit.score,
        files: paths,
      });
    } else if (hit.kind === 'summary') {
      const summary = ctx.memory!.getSessionSummary(hit.refId);
      const paths = summary ? [...summary.filesRead, ...summary.filesEdited] : [];
      if (
        !summary ||
        !scopeAllowsSensitivity(target.policy, summary.scope, summary.sensitivity) ||
        !fileMatches(paths)
      ) {
        continue;
      }
      out.hits.push({
        kind: 'summary',
        id: summary.id,
        scope: summary.scope,
        endId: summary.endId,
        title: compact(summary.request || '会话摘要', 120),
        snippet: compact(summary.completed || summary.learned, 240),
        score: hit.score,
        files: paths,
      });
    } else if (hit.kind === 'document') {
      const document = ctx.memory!.getDocument(hit.refId);
      if (
        !document ||
        document.reviewStatus === 'missing' ||
        !scopeAllowsSensitivity(target.policy, document.scope, document.sensitivity)
      ) {
        continue;
      }
      out.hits.push({
        kind: 'document',
        id: document.id,
        scope: document.scope,
        endId: document.endId,
        title: document.title,
        snippet: compact(document.summary || hit.text, 240),
        score: hit.score,
        path: document.path,
      });
    }
  }
  return out;
}

export function registerMemoryRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/memory/brief', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const brief = buildMemoryBrief(ctx.memory!, target.policy, {
      scope: target.scope,
      // Work sessions never inject private claims; life briefs may include them.
      includePrivate: target.workspace?.family !== 'dev',
    });
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
    const claims = memoryClaimsFor(ctx, target, status);
    const dto: MemoryClaimsResponse = { claims: claims.map((claim) => toClaimDto(claim, ctx)) };
    res.json(dto);
  });

  app.get('/api/memory/claims/:id', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const claim = requireReadableClaim(ctx, req, res, target);
    if (!claim) return;
    res.json({ claim: toClaimDto(claim, ctx) });
  });

  app.patch('/api/memory/claims/:id', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const claim = requireWritableClaim(ctx, req, res, target);
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
    const claim = requireWritableClaim(ctx, req, res, target);
    if (!claim) return;
    ctx.memory!.forgetClaim(claim.id);
    res.json({ ok: true, id: claim.id });
  });

  app.post('/api/memory/claims/:id/promote', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    if (target.workspace?.family !== 'life') {
      res.status(400).json({
        error: 'only life claims can be promoted to user memory',
        code: 'promotion_not_supported',
      });
      return;
    }
    const claim = requireWritableClaim(ctx, req, res, target);
    if (!claim) return;
    const shareClass = req.body?.['shareClass'] ?? 'portable';
    if (shareClass !== 'portable' && shareClass !== 'personal' && shareClass !== 'life_only') {
      res.status(400).json({ error: 'invalid shareClass', code: 'bad_request' });
      return;
    }
    const promoted = ctx.memory!.promoteClaim(claim.id, shareClass);
    if (!promoted) {
      res.status(400).json({ error: 'claim cannot be promoted', code: 'promotion_not_supported' });
      return;
    }
    res.json({ claim: toClaimDto(promoted, ctx) });
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
    // Feedback targets the caller's own claim; cross-read scopes stay read-only.
    ctx.memory!.addFeedback({
      targetType: 'claim',
      targetId,
      action,
      note: typeof req.body?.['note'] === 'string' ? req.body['note'] : null,
      sessionId: target.resolved.sessionId,
    });
    res.json({ ok: true });
  });

  app.get('/api/memory/search', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const query = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
    if (query === '') {
      res.status(400).json({ error: 'q is required', code: 'bad_request' });
      return;
    }
    const requestedLimit = Number(req.query['limit'] ?? 20);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;
    const files =
      typeof req.query['files'] === 'string'
        ? req.query['files']
            .split(',')
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
        : [];
    const fileMatches = (paths: readonly string[]): boolean =>
      files.length === 0 ||
      files.some((wanted) =>
        paths.some((candidate) => candidate.toLowerCase().includes(wanted)),
      );

    const hits = ctx.memory!.searchMemory({
      scopes: target.policy.scopes.map((item) => item.scope),
      query,
      limit: Math.max(limit * 5, limit),
    });

    const dto: MemorySearchResponse = { hits: [] };
    for (const hit of hits) {
      // Only observations / summaries carry file metadata; a files filter is
      // therefore a hard restriction, not an extra ranking signal.
      if (files.length > 0 && hit.kind !== 'observation' && hit.kind !== 'summary') continue;
      if (hit.kind === 'claim') {
        const claim = ctx.memory!.getClaim(hit.refId);
        if (!claim || claim.status !== 'active' || !claimAllowed(claim, target.policy)) continue;
        dto.hits.push({
          kind: 'claim',
          id: claim.id,
          scope: claim.scope,
          endId: claim.endId,
          title: claim.summary,
          snippet: compact(claim.summary, 240),
          score: hit.score,
        });
      } else if (hit.kind === 'source') {
        const source = ctx.memory!.getSource(hit.refId);
        if (
          !source ||
          source.status === 'excluded' ||
          !scopeAllowsSensitivity(target.policy, source.scope, source.sensitivity)
        ) {
          continue;
        }
        dto.hits.push({
          kind: 'source',
          id: source.id,
          scope: source.scope,
          endId: source.endId,
          title: compact(source.content, 80),
          snippet: compact(source.content, 240),
          score: hit.score,
        });
      } else if (hit.kind === 'observation') {
        const observation = ctx.memory!.getObservation(hit.refId);
        const paths = observation
          ? [...observation.filesRead, ...observation.filesModified]
          : [];
        if (
          !observation ||
          observation.status !== 'active' ||
          !scopeAllowsSensitivity(target.policy, observation.scope, observation.sensitivity) ||
          !fileMatches(paths)
        ) {
          continue;
        }
        dto.hits.push({
          kind: 'observation',
          id: observation.id,
          scope: observation.scope,
          endId: observation.endId,
          title: observation.title,
          snippet: compact(observation.subtitle ?? observation.narrative ?? observation.title, 240),
          score: hit.score,
          files: paths,
        });
      } else if (hit.kind === 'summary') {
        const summary = ctx.memory!.getSessionSummary(hit.refId);
        const paths = summary ? [...summary.filesRead, ...summary.filesEdited] : [];
        if (
          !summary ||
          !scopeAllowsSensitivity(target.policy, summary.scope, summary.sensitivity) ||
          !fileMatches(paths)
        ) {
          continue;
        }
        dto.hits.push({
          kind: 'summary',
          id: summary.id,
          scope: summary.scope,
          endId: summary.endId,
          title: compact(summary.request || '会话摘要', 120),
          snippet: compact(summary.completed || summary.learned, 240),
          score: hit.score,
          files: paths,
        });
      } else if (hit.kind === 'document') {
        const document = ctx.memory!.getDocument(hit.refId);
        if (
          !document ||
          document.reviewStatus === 'missing' ||
          !scopeAllowsSensitivity(target.policy, document.scope, document.sensitivity)
        ) {
          continue;
        }
        dto.hits.push({
          kind: 'document',
          id: document.id,
          scope: document.scope,
          endId: document.endId,
          title: document.title,
          snippet: compact(document.summary || hit.text, 240),
          score: hit.score,
          path: document.path,
        });
      }
      if (dto.hits.length >= limit) break;
    }
    res.json(dto);
  });

  app.get('/api/memory/timeline', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const requestedLimit = Number(req.query['limit'] ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;
    const items: MemoryTimelineItemDto[] = [];
    for (const readScope of target.policy.scopes) {
      for (const observation of ctx.memory!.listObservations(readScope.scope, limit)) {
        if (!scopeAllowsSensitivity(target.policy, observation.scope, observation.sensitivity)) continue;
        items.push({
          kind: 'observation',
          id: observation.id,
          scope: observation.scope,
          endId: observation.endId,
          sessionId: observation.sessionId,
          title: observation.title,
          subtitle: observation.subtitle,
          at: observation.createdAt,
          files: [...observation.filesRead, ...observation.filesModified],
        });
      }
      for (const summary of ctx.memory!.listSessionSummaries(readScope.scope, undefined, limit)) {
        if (!scopeAllowsSensitivity(target.policy, summary.scope, summary.sensitivity)) continue;
        items.push({
          kind: 'summary',
          id: summary.id,
          scope: summary.scope,
          endId: summary.endId,
          sessionId: summary.sessionId,
          title: compact(summary.request || '会话摘要', 120),
          subtitle: summary.completed === '' ? null : compact(summary.completed, 160),
          at: summary.createdAt,
          files: [...summary.filesRead, ...summary.filesEdited],
        });
      }
    }
    items.sort((a, b) => b.at - a.at);
    const dto: MemoryTimelineResponse = { items: items.slice(0, limit) };
    res.json(dto);
  });

  app.get('/api/memory/loops', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const loops = target.policy.scopes.flatMap((readScope) =>
      ctx.memory!.listOpenLoops(readScope.scope).map((loop) => ({
        ...loop,
        scope: readScope.scope,
      })),
    );
    res.json({ loops });
  });

  app.get('/api/memory/sources/:id', (req, res) => {
    const target = resolveScope(ctx, req, res);
    if (!target) return;
    const source = ctx.memory!.getSource(req.params['id']!);
    if (
      !source ||
      !scopeAllowsSensitivity(target.policy, source.scope, source.sensitivity)
    ) {
      res.status(404).json({ error: 'source not found', code: 'source_not_found' });
      return;
    }
    const dto: MemorySourceDto = {
      id: source.id,
      scope: source.scope,
      endId: source.endId,
      kind: source.kind,
      sessionId: source.sessionId,
      runId: source.runId,
      occurredAt: source.occurredAt,
      content: source.content,
      sensitivity: source.sensitivity,
      status: source.status,
    };
    res.json({ source: dto });
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
    if (!workspace || !isMemoryEnabled(workspace, ctx.db.getMemorySettings(workspace.id))) {
      res.status(400).json({ error: 'memory is not enabled for this workspace', code: 'memory_not_enabled' });
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
    const lifeEnd =
      workspace.family === 'life'
        ? ends.find((end) => end.kind === 'life' && end.status === 'active')
        : undefined;
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
        pendingSources: target.policy.scopes.reduce(
          (total, readScope) => total + ctx.memory!.countSources('pending', readScope.scope),
          0,
        ),
        lastConsolidatedAt: numberState(ctx, 'last_consolidated_at'),
        lastSuccessAt: numberState(ctx, 'last_success_at'),
        consecutiveFailures: Number(ctx.memory!.getState('consecutive_failures') ?? 0),
        extractionModel,
        modelAvailable,
        enabled: target.workspace
          ? effectiveMemorySettings(
              target.workspace,
              ctx.db.getMemorySettings(target.workspace.id),
            ).enabled
          : true,
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
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (session.kind !== 'chat') {
      res.status(400).json({ error: 'only chat sessions have memory', code: 'session_not_chat' });
      return;
    }
    // The per-session switch is a privacy choice, not a feature toggle: it must
    // be savable even while the workspace itself has memory disabled (dev is
    // off by default). Capture/injection already gate on the workspace switch.
    const previousMode = session.memory_mode;
    ctx.db.setSessionMemoryMode(session.id, mode as MemorySessionMode);
    // Turning off is a hard privacy boundary: anything said while off must not
    // be backfilled when memory is enabled again.
    if (previousMode === 'off' && mode !== 'off') {
      ctx.db.setSessionMemoryCaptureAfterMessageId(session.id, ctx.db.maxMessageId(session.id));
    }
    res.json({ sessionId: session.id, mode });
  });

  app.get('/api/workspaces/:id/memory', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    res.json(workspaceMemoryDto(ctx, workspace));
  });

  app.patch('/api/workspaces/:id/memory', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const life = workspace.family === 'life';
    if (body['profileMode'] !== undefined && !life) {
      res.status(400).json({
        error: 'profileMode is only available for the life workspace',
        code: 'bad_setting',
      });
      return;
    }
    if (body['lifeReadable'] !== undefined && life) {
      res.status(400).json({
        error: 'lifeReadable is only available for dev workspaces',
        code: 'bad_setting',
      });
      return;
    }
    if (
      (body['enabled'] !== undefined && typeof body['enabled'] !== 'boolean') ||
      (body['injectionEnabled'] !== undefined && typeof body['injectionEnabled'] !== 'boolean') ||
      (body['lifeReadable'] !== undefined && typeof body['lifeReadable'] !== 'boolean')
    ) {
      res.status(400).json({ error: 'enabled/injectionEnabled must be boolean', code: 'bad_setting' });
      return;
    }
    if (body['profileMode'] !== undefined && !isMemoryProfileMode(body['profileMode'])) {
      res.status(400).json({ error: 'invalid profileMode', code: 'bad_setting' });
      return;
    }
    let providerOverride = effectiveMemorySettings(
      workspace,
      ctx.db.getMemorySettings(workspace.id),
    ).providerOverride;
    if (body['providerOverride'] !== undefined) {
      const raw = body['providerOverride'];
      if (raw !== null && typeof raw !== 'string') {
        res.status(400).json({ error: 'providerOverride must be a string or null', code: 'bad_setting' });
        return;
      }
      providerOverride = raw === null ? null : raw.trim() || null;
    }

    const current = effectiveMemorySettings(workspace, ctx.db.getMemorySettings(workspace.id));
    const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : current.enabled;
    const injectionEnabled =
      typeof body['injectionEnabled'] === 'boolean'
        ? body['injectionEnabled']
        : current.injectionEnabled;
    ctx.db.putMemorySettings(workspace.id, { enabled, injectionEnabled, providerOverride });
    if (body['profileMode'] !== undefined) {
      ctx.db.updateWorkspaceMemory(workspace.id, {
        profileMode: body['profileMode'] as MemoryProfileMode,
      });
    }
    if (typeof body['lifeReadable'] === 'boolean') {
      ctx.db.updateWorkspaceMemory(workspace.id, { lifeReadable: body['lifeReadable'] });
    }
    res.json(workspaceMemoryDto(ctx, ctx.db.getWorkspace(workspace.id)!));
  });

  // ---- internal endpoints for the paboot_memory MCP server (server token) ----

  app.get('/api/internal/memory/search', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target) return;
    const query = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
    if (!query) {
      res.status(400).json({ error: 'q is required', code: 'bad_request' });
      return;
    }
    const limit = Number(req.query['limit'] ?? 20);
    const files = typeof req.query['files'] === 'string'
      ? req.query['files'].split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    res.json(internalSearchHits(ctx, target, query, Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20, files));
  });

  app.get('/api/internal/memory/timeline', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target) return;
    const requested = Number(req.query['limit'] ?? 50);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 200) : 50;
    const items: MemoryTimelineItemDto[] = [];
    for (const readScope of target.policy.scopes) {
      for (const observation of ctx.memory!.listObservations(readScope.scope, limit)) {
        if (!scopeAllowsSensitivity(target.policy, observation.scope, observation.sensitivity)) continue;
        items.push({
          kind: 'observation',
          id: observation.id,
          scope: observation.scope,
          endId: observation.endId,
          sessionId: observation.sessionId,
          title: observation.title,
          subtitle: observation.subtitle,
          at: observation.createdAt,
          files: [...observation.filesRead, ...observation.filesModified],
        });
      }
      for (const summary of ctx.memory!.listSessionSummaries(readScope.scope, undefined, limit)) {
        if (!scopeAllowsSensitivity(target.policy, summary.scope, summary.sensitivity)) continue;
        items.push({
          kind: 'summary',
          id: summary.id,
          scope: summary.scope,
          endId: summary.endId,
          sessionId: summary.sessionId,
          title: compact(summary.request || '会话摘要', 120),
          subtitle: summary.completed === '' ? null : compact(summary.completed, 160),
          at: summary.createdAt,
          files: [...summary.filesRead, ...summary.filesEdited],
        });
      }
    }
    items.sort((a, b) => b.at - a.at);
    const dto: MemoryTimelineResponse = { items: items.slice(0, limit) };
    res.json(dto);
  });

  app.get('/api/internal/memory/sources/:id', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target) return;
    const source = ctx.memory!.getSource(req.params['id']!);
    if (
      !source ||
      source.status === 'excluded' ||
      !scopeAllowsSensitivity(target.policy, source.scope, source.sensitivity)
    ) {
      res.status(404).json({ error: 'source not found', code: 'source_not_found' });
      return;
    }
    res.json({
      source: {
        id: source.id,
        scope: source.scope,
        endId: source.endId,
        kind: source.kind,
        sessionId: source.sessionId,
        runId: source.runId,
        occurredAt: source.occurredAt,
        content: source.content,
        sensitivity: source.sensitivity,
        status: source.status,
      } satisfies MemorySourceDto,
    });
  });

  app.get('/api/internal/memory/loops', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target) return;
    res.json({
      loops: target.policy.scopes.flatMap((readScope) =>
        ctx.memory!.listOpenLoops(readScope.scope).map((loop) => ({
          ...loop,
          scope: readScope.scope,
        })),
      ),
    });
  });

  app.post('/api/internal/memory/remember', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target || !target.workspace) return;
    const raw = typeof req.body?.['text'] === 'string' ? req.body['text'] : '';
    const content = filterCaptureText(raw);
    if (content === '') {
      res.status(400).json({ error: 'text has no capturable content', code: 'empty_content' });
      return;
    }
    const sessionId = target.resolved.sessionId!;
    const session = ctx.db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const endId = session.end_id ?? null;
    if (ctx.memory!.hasTombstone(target.scope, endId, hashContent(content))) {
      res.status(409).json({ error: 'this content was forgotten', code: 'forgotten_content' });
      return;
    }
    const result = ctx.memory!.insertSource({
      scope: target.scope as MemoryScope,
      workspaceId: target.workspace.id,
      endId,
      kind: 'manual',
      sourceTable: 'note',
      sessionId,
      messageId: null,
      occurredAt: Date.now(),
      content,
      meta: { origin: 'mcp_remember' },
    });
    ctx.memoryWorker?.kick();
    res.json({ ok: true, sourceId: result.source.id });
  });

  app.post('/api/internal/memory/forget', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target) return;
    const claimId = typeof req.body?.['claimId'] === 'string' ? req.body['claimId'] : '';
    const claim = claimId ? ctx.memory!.getClaim(claimId) : undefined;
    if (!claim || claim.scope !== target.scope || claim.sensitivity === 'secret') {
      res.status(404).json({ error: 'claim not found', code: 'claim_not_found' });
      return;
    }
    ctx.memory!.forgetClaim(claim.id);
    res.json({ ok: true, id: claim.id });
  });

  app.post('/api/internal/memory/loops/:id/complete', (req, res) => {
    const target = resolveInternalTarget(ctx, req, res);
    if (!target) return;
    const loopId = req.params['id']!;
    const done = target.policy.scopes.some((readScope) =>
      ctx.memory!.completeLoop(readScope.scope, loopId),
    );
    if (!done) {
      res.status(404).json({ error: 'open loop not found', code: 'loop_not_found' });
      return;
    }
    res.json({ ok: true, id: loopId });
  });
}

function workspaceMemoryDto(ctx: AppContext, workspace: WorkspaceRow): WorkspaceMemoryDto {
  const effective = effectiveMemorySettings(
    workspace,
    ctx.db.getMemorySettings(workspace.id),
  );
  return {
    workspaceId: workspace.id,
    enabled: effective.enabled,
    injectionEnabled: effective.injectionEnabled,
    ...(effective.profileMode === undefined ? {} : { profileMode: effective.profileMode }),
    ...(effective.lifeReadable === undefined ? {} : { lifeReadable: effective.lifeReadable }),
    providerOverride: effective.providerOverride,
  };
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length <= max ? normalized : `${chars.slice(0, max - 1).join('')}…`;
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
