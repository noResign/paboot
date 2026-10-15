import type { Express } from 'express';
import type { AppContext } from '../context.js';
import {
  getDefaultPermissionMode,
  isProductPermissionMode,
  SETTING_DEFAULT_PERMISSION_MODE,
} from '../permission-mode.js';

function configDto(ctx: AppContext) {
  const defaultWorkspace = ctx.db.getDefaultWorkspace();
  return {
    defaultPermissionMode: getDefaultPermissionMode(ctx.db, ctx.config),
    defaultWorkspaceId: defaultWorkspace?.id ?? null,
    workspaces: ctx.db.listWorkspaces().map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      isDefault: w.is_default === 1,
      enabled: w.enabled === 1,
    })),
    server: {
      host: ctx.config.host,
      port: ctx.config.port,
      // Read-only: the data root is fixed at `~/.paboot` and no longer settable,
      // so it is reported for diagnostics only, never as a restart-required knob.
      dataDir: ctx.config.dataDir,
      tls: ctx.config.tls !== null,
      restartRequired: ['host', 'port', 'tls'],
    },
  };
}

export function registerConfigRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/config', (_req, res) => {
    res.json(configDto(ctx));
  });

  app.patch('/api/config', (req, res) => {
    const body = (req.body ?? {}) as { defaultPermissionMode?: unknown; defaultWorkspaceId?: unknown };

    if (body.defaultPermissionMode !== undefined) {
      if (!isProductPermissionMode(body.defaultPermissionMode)) {
        res.status(400).json({ error: 'defaultPermissionMode must be ask, acceptEdits or bypass', code: 'bad_request' });
        return;
      }
      ctx.db.setSetting(SETTING_DEFAULT_PERMISSION_MODE, body.defaultPermissionMode);
    }

    if (body.defaultWorkspaceId !== undefined) {
      if (typeof body.defaultWorkspaceId !== 'string') {
        res.status(400).json({ error: 'defaultWorkspaceId must be a string or null', code: 'bad_request' });
        return;
      }
      if (body.defaultWorkspaceId === '') {
        res.status(400).json({ error: 'defaultWorkspaceId cannot be empty', code: 'bad_request' });
        return;
      }
      const ws = ctx.db.getWorkspace(body.defaultWorkspaceId);
      if (!ws || ws.enabled !== 1) {
        res.status(404).json({ error: 'workspace not found or disabled', code: 'workspace_not_found' });
        return;
      }
      ctx.db.setDefaultWorkspace(ws.id);
    }

    ctx.db.audit('update_config', JSON.stringify({
      defaultPermissionMode: body.defaultPermissionMode ?? null,
      defaultWorkspaceId: body.defaultWorkspaceId ?? null,
    }));
    res.json({ ok: true, config: configDto(ctx) });
  });
}
