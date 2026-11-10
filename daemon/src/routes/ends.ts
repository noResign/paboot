import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import type { EndRow, WorkspaceRow } from '../db/db.js';
import { authRole } from '../http/auth.js';
import { workspaceContains } from '../workspaces/workspace-service.js';
import type {
  EndDto,
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
  };
}

function workspaceFor(ctx: AppContext, id: string): WorkspaceRow | undefined {
  return ctx.db.getWorkspace(id);
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

  app.delete('/api/workspaces/:id/ends/:endId', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = workspaceFor(ctx, req.params['id']!);
    const end = ctx.db.getEnd(req.params['endId']!);
    if (!workspace || !end || end.workspace_id !== workspace.id) {
      res.status(404).json({ error: 'end not found', code: 'end_not_found' });
      return;
    }
    // The end only scopes capabilities and the main-end hint; sessions stay
    // in the workspace after their end is removed.
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
