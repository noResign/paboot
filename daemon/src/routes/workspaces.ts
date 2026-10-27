import path from 'node:path';
import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import type { WorkspaceRow } from '../db/db.js';
import { canonicalizeExistingDirectory, existingDirs, WorkspaceValidationError } from '../workspaces/workspace-service.js';
import { listActiveRuns } from '../runtimes/active-runs.js';

function workspaceDto(w: WorkspaceRow, sessionCount = 0, dirs: string[] = [], shortcutDirs: string[] = []) {
  return {
    id: w.id,
    name: w.name,
    path: w.path,
    dirs,
    shortcutDirs,
    isDefault: w.is_default === 1,
    isBuiltin: w.is_builtin === 1,
    enabled: w.enabled === 1,
    sessionCount,
    createdAt: w.created_at,
    lastUsedAt: w.last_used_at,
  };
}

function sendValidationError(res: import('express').Response, err: unknown): void {
  if (err instanceof WorkspaceValidationError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' });
}

export function registerWorkspaceRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/workspaces', (_req, res) => {
    const counts = ctx.db.countSessionsByWorkspace();
    const dirsByWorkspace = ctx.db.listAllWorkspaceDirs();
    const shortcutsByWorkspace = ctx.db.listAllWorkspaceShortcuts();
    res.json({
      workspaces: ctx.db
        .listVisibleWorkspaces()
        .map((w) =>
          workspaceDto(
            w,
            counts.get(w.id) ?? 0,
            dirsByWorkspace.get(w.id) ?? [],
            shortcutsByWorkspace.get(w.id) ?? [],
          ),
        ),
    });
  });

  app.post('/api/workspaces', (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; path?: unknown };
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    try {
      const realPath = canonicalizeExistingDirectory(rawPath);
      const workspaces = ctx.db.listWorkspaces();
      const duplicate = workspaces.find((w) => w.path === realPath);
      if (duplicate) {
        res.status(409).json({ error: 'workspace already exists', code: 'workspace_exists', workspace: workspaceDto(duplicate) });
        return;
      }
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : path.basename(realPath) || realPath;
      // The first real workspace replaces the built-in fallback as the default;
      // later ones only become default when the user asks for it.
      const hasUserWorkspace = workspaces.some((w) => w.is_builtin !== 1 && w.enabled === 1);
      const created = ctx.db.createWorkspace({ name, path: realPath, isDefault: !hasUserWorkspace });
      ctx.db.audit('create_workspace', JSON.stringify({ id: created.id, path: created.path }));
      res.status(201).json({ ok: true, workspace: workspaceDto(created, 0) });
    } catch (err) {
      sendValidationError(res, err);
    }
  });

  app.patch('/api/workspaces/:id', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; isDefault?: unknown; enabled?: unknown };
    // The built-in fallback is not a user choice: keep it enabled, and never let
    // it hold the default while a real workspace exists (clients would be
    // pointed at a workspace they cannot see).
    if (workspace.is_builtin === 1) {
      const realWorkspaceExists = ctx.db.listWorkspaces().some((w) => w.is_builtin !== 1 && w.enabled === 1);
      if (body.enabled === false || (body.isDefault === true && realWorkspaceExists)) {
        res.status(409).json({ error: 'built-in workspace cannot be disabled or default', code: 'workspace_is_builtin' });
        return;
      }
    }
    const update: { name?: string; enabled?: boolean } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string', code: 'bad_request' });
        return;
      }
      update.name = body.name.trim().slice(0, 80);
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be boolean', code: 'bad_request' });
        return;
      }
      update.enabled = body.enabled;
    }
    if (body.isDefault !== undefined) {
      if (typeof body.isDefault !== 'boolean') {
        res.status(400).json({ error: 'isDefault must be boolean', code: 'bad_request' });
        return;
      }
      if (body.isDefault && body.enabled === false) {
        res.status(409).json({ error: 'default workspace cannot be disabled in the same request', code: 'workspace_disabled' });
        return;
      }
      if (body.isDefault) {
        if (workspace.enabled !== 1) {
          res.status(409).json({ error: 'disabled workspace cannot be default', code: 'workspace_disabled' });
          return;
        }
        ctx.db.setDefaultWorkspace(workspace.id);
      }
    }

    ctx.db.updateWorkspace(workspace.id, update);
    ctx.db.audit('update_workspace', JSON.stringify({ id: workspace.id, update }));
    const updated = ctx.db.getWorkspace(workspace.id) as WorkspaceRow;
    const counts = ctx.db.countSessionsByWorkspace();
    res.json({
      ok: true,
      workspace: workspaceDto(
        updated,
        counts.get(updated.id) ?? 0,
        ctx.db.listWorkspaceDirs(updated.id),
        ctx.db.listWorkspaceShortcuts(updated.id),
      ),
    });
  });

  // Extra dirs granted to a workspace. Written either here by the user or by
  // the Read/Grep approval path (routes/permissions.ts) — same store, so a dir
  // approved from a chat shows up in the management page and vice versa.
  app.post('/api/workspaces/:id/dirs', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { path?: unknown };
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    try {
      const realPath = canonicalizeExistingDirectory(rawPath);
      if (realPath === workspace.path) {
        res.status(400).json({ error: 'path is already the workspace primary dir', code: 'primary_dir' });
        return;
      }
      if (ctx.db.listWorkspaceDirs(workspace.id).includes(realPath)) {
        res.status(409).json({ error: 'dir already granted', code: 'dir_exists' });
        return;
      }
      ctx.db.addWorkspaceDir(workspace.id, realPath);
      ctx.db.audit('add_workspace_dir', JSON.stringify({ workspaceId: workspace.id, path: realPath, via: 'client' }));
      res.status(201).json({ ok: true, dirs: ctx.db.listWorkspaceDirs(workspace.id) });
    } catch (err) {
      sendValidationError(res, err);
    }
  });

  app.delete('/api/workspaces/:id/dirs', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { path?: unknown };
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    // Match however the stored entry is spelled: canonicalize when the dir still
    // exists, else fall back to the resolved form so an already-deleted dir can
    // still be cleaned out of the list.
    const stored = existingDirs([rawPath])[0] ?? path.resolve(rawPath);
    ctx.db.removeWorkspaceDir(workspace.id, stored);
    ctx.db.audit('remove_workspace_dir', JSON.stringify({ workspaceId: workspace.id, path: stored }));
    res.json({ ok: true, dirs: ctx.db.listWorkspaceDirs(workspace.id) });
  });

  // 浏览快捷方式：文件 Tab 的书签。**不授予 agent 任何权限**，只多一个可切换的 tab，
  // 所以校验比 dirs 宽松（不看是否与授权目录重叠，只看「不是重复的 tab」）。
  app.post('/api/workspaces/:id/shortcuts', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { path?: unknown };
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    try {
      const realPath = canonicalizeExistingDirectory(rawPath);
      // 去重：已经在 tab 行上的目录（主目录、附加目录、已有快捷方式）不再加一次。
      const existing = [workspace.path, ...ctx.db.listWorkspaceDirs(workspace.id), ...ctx.db.listWorkspaceShortcuts(workspace.id)];
      if (existing.includes(realPath)) {
        res.status(409).json({ error: 'already a tab of this workspace', code: 'shortcut_exists' });
        return;
      }
      ctx.db.addWorkspaceShortcut(workspace.id, realPath);
      ctx.db.audit('add_workspace_shortcut', JSON.stringify({ workspaceId: workspace.id, path: realPath }));
      res.status(201).json({ ok: true, shortcutDirs: ctx.db.listWorkspaceShortcuts(workspace.id) });
    } catch (err) {
      sendValidationError(res, err);
    }
  });

  app.delete('/api/workspaces/:id/shortcuts', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { path?: unknown };
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      res.status(400).json({ error: 'path is required', code: 'bad_request' });
      return;
    }
    const stored = existingDirs([rawPath])[0] ?? path.resolve(rawPath);
    ctx.db.removeWorkspaceShortcut(workspace.id, stored);
    ctx.db.audit('remove_workspace_shortcut', JSON.stringify({ workspaceId: workspace.id, path: stored }));
    res.json({ ok: true, shortcutDirs: ctx.db.listWorkspaceShortcuts(workspace.id) });
  });

  // 删工作区只删注册信息，磁盘上的目录/文件一律不动。带 `?cascade=1` 时连它的会话一起
  // 删（聊天记录、run、事件、会话级授权）；不带时只要还有会话就 409。
  //
  // 默认工作区可以删，只要还有另一处可落地：daemon 先把默认切给另一个真实工作区，
  // 没有就切给内置 fallback。内置 fallback 自己不可删（它是最后的兜底）。这样「工作区数
  // 为零」仍然不可达，但用户不会因为删不掉最后一个真实工作区而卡住。
  //
  // 注意级联也**不会**删 `~/.claude/projects/<cwd>/<id>.jsonl`——那是 Claude Code 自己的
  // 会话记录，删了会破坏电脑上的续接，所以同一个目录重新加成工作区后，续接列表里还能看到它们。
  app.delete('/api/workspaces/:id', (req, res) => {
    const workspace = ctx.db.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.is_builtin === 1) {
      res.status(409).json({ error: 'built-in workspace cannot be deleted', code: 'workspace_is_builtin' });
      return;
    }
    const cascade = req.query.cascade === '1' || req.query.cascade === 'true';
    // Hidden command-task sessions are internal bookkeeping: they should never
    // block deleting a workspace and must be cleaned up along with it.
    const visibleSessions = ctx.db.listSessions(workspace.id);
    if (visibleSessions.length > 0 && !cascade) {
      res.status(409).json({
        error: `workspace still has ${visibleSessions.length} session(s)`,
        code: 'workspace_not_empty',
        sessionCount: visibleSessions.length,
      });
      return;
    }
    if (workspace.is_default === 1) {
      const enabled = ctx.db.listWorkspaces().filter((w) => w.id !== workspace.id && w.enabled === 1);
      const fallback = enabled.find((w) => w.is_builtin !== 1) ?? enabled[0];
      if (!fallback) {
        res.status(409).json({
          error: 'default workspace cannot be deleted',
          code: 'workspace_is_default',
        });
        return;
      }
      ctx.db.setDefaultWorkspace(fallback.id);
    }
    const allSessions = ctx.db.listAllSessions(workspace.id);
    for (const session of allSessions) {
      // 先取消在跑的 run：否则子进程会被遗留，且它退出时还会往已删的 run 写事件。
      for (const active of listActiveRuns()) {
        const row = ctx.db.getRun(active.id);
        if (row && row.session_id === session.id) active.cancel('workspace deleted');
      }
      ctx.db.deleteSession(session.id);
      ctx.permissions.clearSession(session.id);
    }
    ctx.db.deleteWorkspace(workspace.id);
    ctx.db.audit(
      'delete_workspace',
      JSON.stringify({ id: workspace.id, cascade, sessions: visibleSessions.length }),
    );
    res.json({ ok: true, id: workspace.id, deletedSessions: visibleSessions.length });
  });
}
