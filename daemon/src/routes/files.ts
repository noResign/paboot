import fs from 'node:fs';
import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { WorkspaceRow } from '../db/db.js';
import {
  FileBrowserError,
  guessContentType,
  listFiles,
  parseRange,
  readFileContent,
  resolveFile,
} from '../workspaces/file-browser.js';
import {
  canonicalizeExistingDirectory,
  resolveWorkspaceForRequest,
  workspaceRoots,
  WorkspaceValidationError,
} from '../workspaces/workspace-service.js';

function sendFileError(res: import('express').Response, err: unknown): void {
  if (err instanceof FileBrowserError) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof WorkspaceValidationError) {
    res.status(err.code === 'directory_not_found' ? 404 : 400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
}

function boolQuery(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/**
 * Which directory tree to browse. An explicit `root` wins over the workspace's
 * primary dir; it is only checked for existing and being a directory, not for
 * being inside the workspace — browsing anywhere is deliberate (see
 * docs/permissions.md「安全模型」: the workspace is not a sandbox, and the token holder owns the machine).
 */
function resolveRoot(workspace: WorkspaceRow, requested: unknown): string {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) return workspace.path;
  return canonicalizeExistingDirectory(raw);
}

export function registerFileRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/files', (req, res) => {
    const requested = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : undefined;
    const workspace = resolveWorkspaceForRequest(ctx.db, requested);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const root = resolveRoot(workspace, req.query.root);
      if (root !== workspace.path) {
        ctx.db.audit('browse_root', JSON.stringify({ workspaceId: workspace.id, root }));
      }
      const result = listFiles(root, relativePath, {
        cursor: req.query.cursor,
        limit: req.query.limit,
        showHidden: boolQuery(req.query.showHidden),
        showIgnored: boolQuery(req.query.showIgnored),
      });
      res.json({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        root,
        roots: workspaceRoots(ctx.db, workspace),
        shortcutDirs: ctx.db.listWorkspaceShortcuts(workspace.id),
        ...result,
      });
    } catch (err) {
      sendFileError(res, err);
    }
  });

  app.get('/api/files/content', (req, res) => {
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
      const result = readFileContent(root, relativePath);
      res.json({ ...result, root });
    } catch (err) {
      sendFileError(res, err);
    }
  });

  // Raw bytes for previewing media (images / video). Unlike /content this is not
  // size-capped and is not UTF-8 decoded — it streams the file as-is and honors
  // `Range`, which is what lets a video player seek and a large image load in
  // pieces. Auth is the same bearer gate as everything else under /api.
  app.get('/api/files/raw', (req, res) => {
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
    let resolved: { absolute: string; wire: string };
    try {
      const root = resolveRoot(workspace, req.query.root);
      resolved = resolveFile(root, relativePath);
    } catch (err) {
      sendFileError(res, err);
      return;
    }

    let size: number;
    try {
      size = fs.statSync(resolved.absolute).size;
    } catch {
      res.status(404).json({ error: 'file not found', code: 'file_not_found' });
      return;
    }

    const range = parseRange(req.headers.range, size);
    res.setHeader('Content-Type', guessContentType(resolved.wire));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=60');

    if (range === 'invalid') {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }

    let stream: fs.ReadStream;
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      stream = fs.createReadStream(resolved.absolute, { start: range.start, end: range.end });
    } else {
      res.setHeader('Content-Length', String(size));
      stream = fs.createReadStream(resolved.absolute);
    }

    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'read failed', code: 'read_failed' });
      else res.destroy();
    });
    stream.pipe(res);
  });
}
