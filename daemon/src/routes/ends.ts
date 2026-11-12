import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { EndRow, WorkspaceRow } from '../db/db.js';
import { domainById } from '../domains/index.js';
import { authRole } from '../http/auth.js';
import { log } from '../platform/log.js';
import {
  workspaceContains,
  workspaceContainsAny,
  workspaceRoots,
} from '../workspaces/workspace-service.js';
import type {
  EndDto,
  EndImpactDto,
  EndImpactResponse,
  EndResponse,
  EndSuggestionDto,
  EndSuggestionsResponse,
  EndsResponse,
} from '../types/api.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', '.gradle', '.idea']);
const MARKERS = [
  'AndroidManifest.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
];
const MAX_DEPTH = 4;
const MAX_DIRS = 500;

function requireOperator(res: Response): boolean {
  if (authRole(res) === 'operator') return true;
  res.status(403).json({ error: 'operator token required', code: 'operator_required' });
  return false;
}

export function endDto(ctx: AppContext, end: EndRow): EndDto {
  return {
    id: end.id,
    workspaceId: end.workspace_id,
    family: end.family === 'life' ? 'life' : 'dev',
    kind: end.kind,
    name: end.name,
    status: end.status,
    roots: ctx.db.listEndRoots(end.id),
    createdAt: end.created_at,
    archivedAt: end.archived_at ?? null,
    summary: end.summary,
    notes: end.notes,
  };
}

/** Seed the domain's built-in conventions; never overwrite an existing title. */
function seedEndConventions(ctx: AppContext, workspace: WorkspaceRow, end: EndRow): void {
  const template = domainById(end.kind);
  if (!template || !ctx.knowledge || template.conventions.length === 0) return;
  try {
    const existing = new Set(
      ctx.knowledge
        .list(workspace.id, { kind: 'convention', endId: end.id })
        .map((doc) => doc.title),
    );
    for (const convention of template.conventions) {
      if (existing.has(convention.title)) continue;
      ctx.knowledge.create(workspace.id, {
        title: convention.title,
        body: convention.body,
        kind: 'convention',
        endId: end.id,
      });
    }
  } catch (err) {
    log.warn(`end ${end.id}: failed to seed domain conventions`, err);
  }
}

function workspaceFor(ctx: AppContext, id: string): WorkspaceRow | undefined {
  return ctx.db.getWorkspace(id);
}

/** Life ends are managed by the life workspace; only dev ends can be archived. */
function requireDevEnd(res: Response, workspace: WorkspaceRow): boolean {
  if (workspace.family === 'dev') return true;
  res.status(403).json({ error: 'ends are dev-only', code: 'end_not_allowed' });
  return false;
}

function endImpact(ctx: AppContext, workspace: WorkspaceRow, end: EndRow): EndImpactDto {
  const roots = ctx.db.listEndRoots(end.id);
  let cwdSessions = 0;
  for (const session of ctx.db.listAllSessions(workspace.id)) {
    if (session.kind === 'command' || session.end_id) continue;
    if (roots.some((root) => workspaceContains(root, session.cwd))) cwdSessions += 1;
  }
  return {
    endId: end.id,
    status: end.status,
    explicitSessions: ctx.db.countSessionsByEnd(end.id),
    cwdSessions,
    roots: roots.length,
  };
}

async function scanAndroid(
  roots: readonly string[],
  ctx: AppContext,
): Promise<EndSuggestionDto[]> {
  const queue = roots.map((root) => ({ dir: root, depth: 0 }));
  const found = new Map<string, Set<string>>();
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DIRS) {
    const item = queue.shift()!;
    visited += 1;
    // Scan roots include attached dirs, so containment must be checked against
    // the whole root set or attached suggestions get silently dropped.
    if (!workspaceContainsAny(roots, item.dir)) continue;
    let entries;
    try {
      entries = await fs.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const reasons = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!MARKERS.includes(entry.name)) continue;
      if (entry.name.endsWith('.gradle') || entry.name.endsWith('.gradle.kts')) {
        reasons.add('Gradle');
      } else {
        reasons.add('AndroidManifest');
      }
    }
    if (reasons.size > 0) {
      const current = found.get(item.dir) ?? new Set<string>();
      for (const reason of reasons) current.add(reason);
      found.set(item.dir, current);
    }
    if (item.depth >= MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }
  return [...found.entries()].map(([dir, reasons]) => ({
    path: dir,
    reasons: [...reasons],
  }));
}

export function registerEndRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/workspaces/:id/ends', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const dto: EndsResponse = {
      ends: ctx.db.listEnds(workspace.id).map((end) => endDto(ctx, end)),
    };
    res.json(dto);
  });

  app.get('/api/workspaces/:id/end-suggestions', async (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.family !== 'dev') {
      const dto: EndSuggestionsResponse = { suggestions: [] };
      res.json(dto);
      return;
    }
    const dto: EndSuggestionsResponse = {
      suggestions: await scanAndroid(workspaceRoots(ctx.db, workspace), ctx),
    };
    res.json(dto);
  });

  app.post('/api/workspaces/:id/ends', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.family !== 'dev') {
      res.status(403).json({ error: 'ends are dev-only', code: 'end_not_allowed' });
      return;
    }
    const name = typeof req.body?.['name'] === 'string' ? req.body['name'].trim() : '';
    const kind = typeof req.body?.['kind'] === 'string' ? req.body['kind'] : 'android';
    const summary = typeof req.body?.['summary'] === 'string' ? req.body['summary'].trim() : '';
    const notes = typeof req.body?.['notes'] === 'string' ? req.body['notes'] : '';
    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'bad_request' });
      return;
    }
    if (summary.length > 200) {
      res.status(400).json({ error: 'summary is too long (max 200)', code: 'bad_request' });
      return;
    }
    if (notes.length > 4000) {
      res.status(400).json({ error: 'notes are too long (max 4000)', code: 'bad_request' });
      return;
    }
    const end = ctx.db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind,
      name,
      status: 'draft',
    });
    if (summary || notes) ctx.db.updateEnd(end.id, { summary, notes });
    const dto: EndResponse = { ok: true, end: endDto(ctx, ctx.db.getEnd(end.id)!) };
    res.status(201).json(dto);
  });

  app.patch('/api/workspaces/:id/ends/:endId', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: { name?: string; summary?: string; notes?: string } = {};
    if (body['name'] !== undefined) {
      const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
      if (!name || name.length > 80) {
        res.status(400).json({ error: 'name must be 1-80 characters', code: 'bad_request' });
        return;
      }
      input.name = name;
    }
    if (body['summary'] !== undefined) {
      if (typeof body['summary'] !== 'string' || body['summary'].length > 200) {
        res.status(400).json({ error: 'summary must be a string of at most 200 characters', code: 'bad_request' });
        return;
      }
      input.summary = body['summary'].trim();
    }
    if (body['notes'] !== undefined) {
      if (typeof body['notes'] !== 'string' || body['notes'].length > 4000) {
        res.status(400).json({ error: 'notes must be a string of at most 4000 characters', code: 'bad_request' });
        return;
      }
      input.notes = body['notes'];
    }
    if (Object.keys(input).length === 0) {
      res.status(400).json({ error: 'nothing to update', code: 'bad_request' });
      return;
    }
    let updated: EndRow | undefined;
    try {
      updated = ctx.db.updateEnd(end.id, input);
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        res.status(409).json({ error: 'an end with that name already exists', code: 'end_name_exists' });
        return;
      }
      throw err;
    }
    if (!updated) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    ctx.db.audit(
      'end_update',
      JSON.stringify({ workspaceId: workspace.id, endId: end.id, fields: Object.keys(input) }),
    );
    const dto: EndResponse = { ok: true, end: endDto(ctx, updated) };
    res.json(dto);
  });

  app.post('/api/workspaces/:id/ends/:endId/roots', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    const root = typeof req.body?.['path'] === 'string' ? req.body['path'].trim() : '';
    if (!root) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    const absolute = path.resolve(root);
    if (!workspaceContainsAny(workspaceRoots(ctx.db, workspace), absolute)) {
      res.status(400).json({
        error: 'root must be inside the workspace or one of its extra dirs',
        code: 'root_outside',
      });
      return;
    }
    ctx.db.addEndRoot(end.id, absolute);
    const dto: EndResponse = { ok: true, end: endDto(ctx, ctx.db.getEnd(end.id)!) };
    res.json(dto);
  });

  app.delete('/api/workspaces/:id/ends/:endId/roots', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    const root = typeof req.body?.['path'] === 'string' ? req.body['path'].trim() : '';
    if (!root) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    ctx.db.removeEndRoot(end.id, path.resolve(root));
    const dto: EndResponse = { ok: true, end: endDto(ctx, ctx.db.getEnd(end.id)!) };
    res.json(dto);
  });

  app.get('/api/workspaces/:id/ends/:endId/impact', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    const dto: EndImpactResponse = { impact: endImpact(ctx, workspace, end) };
    res.json(dto);
  });

  app.post('/api/workspaces/:id/ends/:endId/archive', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    if (!requireDevEnd(res, workspace)) return;
    if (end.status === 'archived') {
      res.json({ ok: true, end: endDto(ctx, end) } satisfies EndResponse);
      return;
    }
    if (end.status !== 'active') {
      res.status(409).json({ error: 'end is not active', code: 'end_not_active' });
      return;
    }
    const impact = endImpact(ctx, workspace, end);
    const archived = ctx.db.setEndStatus(end.id, 'archived');
    if (!archived) {
      res.status(500).json({ error: 'failed to archive end', code: 'internal_error' });
      return;
    }
    ctx.db.audit(
      'end_archive',
      JSON.stringify({ workspaceId: workspace.id, endId: end.id, name: end.name, impact }),
    );
    try {
      ctx.knowledge?.archiveEndData(workspace.id, end.id);
    } catch (err) {
      log.warn(`end ${end.id}: failed to archive knowledge`, err);
    }
    res.json({ ok: true, end: endDto(ctx, archived) } satisfies EndResponse);
  });

  app.post('/api/workspaces/:id/ends/:endId/restore', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    if (!requireDevEnd(res, workspace)) return;
    if (end.status === 'active') {
      res.json({ ok: true, end: endDto(ctx, end) } satisfies EndResponse);
      return;
    }
    if (end.status !== 'archived') {
      res.status(409).json({ error: 'end is not archived', code: 'end_not_archived' });
      return;
    }
    if (ctx.db.listEndRoots(end.id).length === 0) {
      res.status(409).json({ error: 'bind at least one directory first', code: 'end_has_no_roots' });
      return;
    }
    const restored = ctx.db.setEndStatus(end.id, 'active');
    if (!restored) {
      res.status(500).json({ error: 'failed to restore end', code: 'internal_error' });
      return;
    }
    ctx.db.audit('end_restore', JSON.stringify({ workspaceId: workspace.id, endId: end.id, name: end.name }));
    try {
      ctx.knowledge?.restoreEndData(workspace.id, end.id);
      seedEndConventions(ctx, workspace, restored);
    } catch (err) {
      log.warn(`end ${end.id}: failed to restore knowledge`, err);
    }
    res.json({ ok: true, end: endDto(ctx, restored) } satisfies EndResponse);
  });

  app.delete('/api/workspaces/:id/ends/:endId', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    if (!requireDevEnd(res, workspace)) return;
    if (end.status === 'active') {
      res.status(409).json({ error: 'archive the end before deleting it', code: 'end_must_archive' });
      return;
    }
    const impact = endImpact(ctx, workspace, end);
    // The end only scopes context and the main-end hint; sessions stay
    // in the workspace after their end is removed.
    ctx.db.audit(
      'end_delete',
      JSON.stringify({ workspaceId: workspace.id, endId: end.id, name: end.name, impact }),
    );
    try {
      // Hard delete removes the end's knowledge; archive keeps it in place.
      ctx.knowledge?.deleteEndData(workspace.id, end.id);
    } catch (err) {
      log.warn(`end ${end.id}: failed to delete knowledge`, err);
    }
    ctx.db.deleteEnd(end.id);
    res.json({ ok: true });
  });

  app.post('/api/workspaces/:id/ends/:endId/activate', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    if (ctx.db.listEndRoots(end.id).length === 0) {
      res.status(409).json({ error: 'bind at least one directory first', code: 'end_has_no_roots' });
      return;
    }
    const active = ctx.db.setEndStatus(end.id, 'active');
    if (!active) {
      res.status(500).json({ error: 'failed to activate end', code: 'internal_error' });
      return;
    }
    seedEndConventions(ctx, workspace, active);
    const dto: EndResponse = { ok: true, end: endDto(ctx, ctx.db.getEnd(end.id)!) };
    res.json(dto);
  });
}
