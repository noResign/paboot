import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { EndRow, WorkspaceRow } from '../db/db.js';
import { capabilityById } from '../capabilities/registry.js';
import { authRole } from '../http/auth.js';
import { workspaceContains } from '../workspaces/workspace-service.js';
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

function endDto(ctx: AppContext, end: EndRow): EndDto {
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
  };
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
  const bindings = ctx.db.listCapabilityBindings('end', end.id);
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
    capabilityBindings: bindings.length,
    roots: roots.length,
    capabilities: [
      ...new Set(
        bindings
          .filter((binding) => binding.enabled === 1)
          .map((binding) => capabilityById(binding.provider_id)?.name ?? binding.provider_id),
      ),
    ],
  };
}

async function scanAndroid(
  roots: readonly string[],
  ctx: AppContext,
  workspace: WorkspaceRow,
): Promise<EndSuggestionDto[]> {
  const queue = roots.map((root) => ({ dir: root, depth: 0 }));
  const found = new Map<string, Set<string>>();
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DIRS) {
    const item = queue.shift()!;
    visited += 1;
    if (!workspaceContains(workspace.path, item.dir)) continue;
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
    const roots = [workspace.path, ...ctx.db.listWorkspaceDirs(workspace.id)];
    const dto: EndSuggestionsResponse = {
      suggestions: await scanAndroid(roots, ctx, workspace),
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
    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'bad_request' });
      return;
    }
    const end = ctx.db.createEnd({
      workspaceId: workspace.id,
      family: 'dev',
      kind,
      name,
      status: 'draft',
    });
    const dto: EndResponse = { ok: true, end: endDto(ctx, end) };
    res.status(201).json(dto);
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
    if (!workspaceContains(workspace.path, absolute)) {
      res.status(400).json({ error: 'root must be inside the workspace', code: 'root_outside' });
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
    // The end only scopes capabilities and the main-end hint; sessions stay
    // in the workspace after their end is removed.
    ctx.db.audit(
      'end_delete',
      JSON.stringify({ workspaceId: workspace.id, endId: end.id, name: end.name, impact }),
    );
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
    ctx.db.upsertCapabilityBinding({
      scopeType: 'end',
      scopeId: end.id,
      providerId: 'android-device',
      enabled: true,
    });
    const dto: EndResponse = { ok: true, end: endDto(ctx, active) };
    res.json(dto);
  });
}
