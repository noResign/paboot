import type { Express } from 'express';
import type { AppContext } from '../context.js';
import type { WorkspaceRow } from '../db.js';
import { ChangesError, getDiff, listChanges } from '../changes.js';
import {
  canonicalizeExistingDirectory,
  resolveWorkspaceForRequest,
  workspaceRoots,
  WorkspaceValidationError,
} from '../workspace-service.js';

function sendChangesError(res: import('express').Response, err: unknown): void {
  if (err instanceof ChangesError) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof WorkspaceValidationError) {
    res.status(err.code === 'directory_not_found' ? 404 : 400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
}

/**
 * Which tree to inspect for git changes. An explicit `root` wins over the
 * workspace's primary dir and is only checked for existing and being a
 * directory — inspecting repos outside the workspace is deliberate, matching
 * the Files tab (see docs/permissions.md「安全模型」).
 */
function resolveRoot(workspace: WorkspaceRow, requested: unknown): string {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) return workspace.path;
  return canonicalizeExistingDirectory(raw);
}

export function registerChangesRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/changes', async (req, res) => {
    const requested = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    const workspace = resolveWorkspaceForRequest(ctx.db, requested);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    try {
      const root = resolveRoot(workspace, req.query.root);
      if (root !== workspace.path) {
        ctx.db.audit('browse_root', JSON.stringify({ workspaceId: workspace.id, root, endpoint: 'changes' }));
      }
      const result = await listChanges(root);
      res.json({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        root,
        roots: workspaceRoots(ctx.db, workspace),
        shortcutDirs: ctx.db.listWorkspaceShortcuts(workspace.id),
        ...result,
      });
    } catch (err) {
      sendChangesError(res, err);
    }
  });

  app.get('/api/changes/diff', async (req, res) => {
    const requested = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    const workspace = resolveWorkspaceForRequest(ctx.db, requested);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relativePath) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    try {
      const root = resolveRoot(workspace, req.query.root);
      const result = await getDiff(root, relativePath);
      res.json({ ...result, root });
    } catch (err) {
      sendChangesError(res, err);
    }
  });
}
