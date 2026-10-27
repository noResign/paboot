import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { WorkspaceRow } from '../db/db.js';
import { ChangesError, getDiff, listChanges } from '../workspaces/changes.js';
import { diffRefs, patchRefFile } from '../workspaces/checkpoints.js';
import {
  canonicalizeExistingDirectory,
  resolveWorkspaceForRequest,
  workspaceRoots,
  WorkspaceValidationError,
} from '../workspaces/workspace-service.js';

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

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

interface RunCheckpointRefs {
  repoRoot: string;
  preRef: string;
  postRef: string;
}

/** A run's `pre..post` refs, or null when it has no usable checkpoint. */
function runCheckpointRefs(ctx: AppContext, runId: string): RunCheckpointRefs | null {
  const cp = ctx.db.getRunCheckpoint(runId);
  if (!cp || cp.status !== 'complete' || !cp.pre_ref || !cp.post_ref) return null;
  return { repoRoot: cp.repo_root, preRef: cp.pre_ref, postRef: cp.post_ref };
}

export function registerChangesRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/changes', async (req, res) => {
    const requested = queryString(req.query.workspaceId);
    const workspace = resolveWorkspaceForRequest(ctx.db, requested);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const runId = queryString(req.query.runId);
    try {
      // `?runId=` reports what a specific run changed (its pre..post checkpoint
      // diff) instead of the workspace's live dirty state.
      if (runId) {
        const cp = runCheckpointRefs(ctx, runId);
        if (!cp) {
          res.status(404).json({ error: 'run has no checkpoint', code: 'no_checkpoint' });
          return;
        }
        const files = await diffRefs(cp.repoRoot, cp.preRef, cp.postRef);
        res.json({
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          root: cp.repoRoot,
          roots: workspaceRoots(ctx.db, workspace),
          shortcutDirs: ctx.db.listWorkspaceShortcuts(workspace.id),
          runId,
          isGitRepo: true,
          gitRoot: cp.repoRoot,
          repos: [],
          files,
        });
        return;
      }

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
    const requested = queryString(req.query.workspaceId);
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
    const runId = queryString(req.query.runId);
    try {
      if (runId) {
        const cp = runCheckpointRefs(ctx, runId);
        if (!cp) {
          res.status(404).json({ error: 'run has no checkpoint', code: 'no_checkpoint' });
          return;
        }
        const normalized = relativePath.replace(/\\/g, '/');
        const files = await diffRefs(cp.repoRoot, cp.preRef, cp.postRef);
        const entry = files.find((file) => file.path === normalized || file.oldPath === normalized);
        if (!entry) {
          throw new ChangesError('file has no changes in this run', 'file_not_changed', 404);
        }
        const patched = await patchRefFile(cp.repoRoot, cp.preRef, cp.postRef, entry.path);
        res.json({
          path: entry.path,
          oldPath: entry.oldPath,
          status: entry.status,
          binary: patched.binary,
          truncated: patched.truncated,
          patch: patched.patch,
          root: cp.repoRoot,
        });
        return;
      }

      const root = resolveRoot(workspace, req.query.root);
      const result = await getDiff(root, relativePath);
      res.json({ ...result, root });
    } catch (err) {
      sendChangesError(res, err);
    }
  });
}
