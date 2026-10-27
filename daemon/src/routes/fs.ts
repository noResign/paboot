import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import { expandHome } from '../platform/paths.js';
import { canonicalizeExistingDirectory, WorkspaceValidationError } from '../workspaces/workspace-service.js';

function listDirectories(dir: string): { name: string; path: string }[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs: { name: string; path: string }[] = [];
  for (const entry of entries) {
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, entry.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    dirs.push({ name: entry.name, path: path.join(dir, entry.name) });
  }
  return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerFsRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/fs/directories', (req, res) => {
    const raw = typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path.trim() : '~';
    const showHidden = req.query.showHidden === 'true' || req.query.showHidden === '1';
    try {
      const dir = canonicalizeExistingDirectory(expandHome(raw));
      const entries = listDirectories(dir)
        .filter((entry) => showHidden || !entry.name.startsWith('.'))
        .map((entry) => ({
          ...entry,
          isWorkspace: ctx.db.getWorkspaceByPath(entry.path) !== undefined,
        }));
      res.json({
        path: dir,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        entries,
      });
    } catch (err) {
      if (err instanceof WorkspaceValidationError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
    }
  });
}
