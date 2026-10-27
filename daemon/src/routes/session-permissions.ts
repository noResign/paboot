import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import { isProductPermissionMode } from '../permissions/permission-mode.js';

export function registerSessionPermissionRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/sessions/:id/permissions', (req, res) => {
    const session = ctx.db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    res.json({
      mode: session.permission_mode,
      grants: ctx.db.listPermissionGrants(session.id).map((g) => ({
        toolName: g.tool_name,
        createdAt: g.created_at,
      })),
    });
  });

  app.patch('/api/sessions/:id/permissions', (req, res) => {
    const session = ctx.db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { mode?: unknown };
    if (!isProductPermissionMode(body.mode)) {
      res.status(400).json({ error: 'mode must be ask, acceptEdits or bypass', code: 'bad_request' });
      return;
    }
    ctx.db.setSessionPermissionMode(session.id, body.mode);
    ctx.db.audit('update_session_permissions', JSON.stringify({ sessionId: session.id, mode: body.mode }));
    res.json({ ok: true, sessionId: session.id, mode: body.mode, effective: 'next_run' });
  });

  app.delete('/api/sessions/:id/permissions/grants/:toolName', (req, res) => {
    const session = ctx.db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    ctx.db.deletePermissionGrant(session.id, req.params.toolName);
    ctx.db.audit('delete_permission_grant', JSON.stringify({ sessionId: session.id, toolName: req.params.toolName }));
    res.json({ ok: true });
  });

  app.delete('/api/sessions/:id/permissions/grants', (req, res) => {
    const session = ctx.db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    ctx.db.deletePermissionGrants(session.id);
    ctx.db.audit('delete_permission_grants', session.id);
    res.json({ ok: true });
  });
}
