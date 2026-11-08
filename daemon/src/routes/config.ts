import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import {
  getDefaultPermissionMode,
  isProductPermissionMode,
  SETTING_DEFAULT_PERMISSION_MODE,
  type ProductPermissionMode,
} from '../permissions/permission-mode.js';
import {
  isBypassAllowed,
  resolveEffectivePermissionMode,
} from '../permissions/security-profile.js';
import { configuredMemoryModel, normalizeMemoryModelSelection, SETTING_MEMORY_MODEL } from '../memory/model.js';
import { log } from '../platform/log.js';

function configDto(ctx: AppContext) {
  // Mirror the visible list: a hidden built-in fallback must not be handed to
  // clients as the default workspace id.
  const workspaces = ctx.db.listVisibleWorkspaces();
  const defaultWorkspace = workspaces.find((w) => w.is_default === 1) ?? workspaces[0] ?? null;
  return {
    defaultPermissionMode: resolveEffectivePermissionMode(
      getDefaultPermissionMode(ctx.db, ctx.config),
      ctx.builtinConfig,
    ),
    securityProfile: ctx.builtinConfig?.securityProfile ?? 'local',
    bypassAllowed: isBypassAllowed(ctx.builtinConfig),
    defaultWorkspaceId: defaultWorkspace?.id ?? null,
    workspaces: workspaces.map((w) => ({
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
    /** Settings-table choice, falling back to PABOOT_MEMORY_MODEL. */
    memoryModel: configuredMemoryModel((key) => ctx.db.getSetting(key), ctx.config.memoryModel),
  };
}

async function validateMemoryModel(ctx: AppContext, value: string): Promise<string | null> {
  return normalizeMemoryModelSelection(value, await ctx.providers.list());
}

export function registerConfigRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/config', (_req, res) => {
    res.json(configDto(ctx));
  });

  app.patch('/api/config', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        defaultPermissionMode?: unknown;
        defaultWorkspaceId?: unknown;
        memoryModel?: unknown;
      };

      // Validate every field before writing any of them. A 400 must not leave
      // a half-applied config patch behind.
      let permissionModeToSet: ProductPermissionMode | undefined;
      let workspaceIdToSet: string | undefined;
      let memoryModelToSet: string | null | undefined;

      if (body.defaultPermissionMode !== undefined) {
        if (!isProductPermissionMode(body.defaultPermissionMode)) {
          res.status(400).json({ error: 'defaultPermissionMode must be ask, acceptEdits or bypass', code: 'bad_request' });
          return;
        }
        permissionModeToSet = resolveEffectivePermissionMode(
          body.defaultPermissionMode,
          ctx.builtinConfig,
        );
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
        if (ws.family === 'life') {
          res.status(409).json({ error: 'life workspace cannot be the default', code: 'workspace_is_life' });
          return;
        }
        if (ws.is_builtin === 1 && ctx.db.listWorkspaces().some((w) => w.is_builtin !== 1 && w.enabled === 1)) {
          res.status(409).json({ error: 'built-in workspace cannot be default while a real workspace exists', code: 'workspace_is_builtin' });
          return;
        }
        workspaceIdToSet = ws.id;
      }

      if (body.memoryModel !== undefined) {
        if (body.memoryModel === null || body.memoryModel === '') {
          memoryModelToSet = null;
        } else if (typeof body.memoryModel !== 'string') {
          res.status(400).json({ error: 'memoryModel must be a provider:model string or null', code: 'bad_request' });
          return;
        } else {
          const requested = body.memoryModel.trim();
          if (requested === '') {
            memoryModelToSet = null;
          } else {
            const model = await validateMemoryModel(ctx, requested);
            if (!model) {
              res.status(400).json({
                error: 'memoryModel must be an enabled model with a configured API key',
                code: 'invalid_memory_model',
              });
              return;
            }
            memoryModelToSet = model;
          }
        }
      }

      // All validation passed; commit the patch.
      if (permissionModeToSet !== undefined) {
        ctx.db.setSetting(SETTING_DEFAULT_PERMISSION_MODE, permissionModeToSet);
      }
      if (workspaceIdToSet !== undefined) {
        ctx.db.setDefaultWorkspace(workspaceIdToSet);
      }
      if (memoryModelToSet !== undefined) {
        if (memoryModelToSet === null) ctx.db.deleteSetting(SETTING_MEMORY_MODEL);
        else ctx.db.setSetting(SETTING_MEMORY_MODEL, memoryModelToSet);
      }

      ctx.db.audit('update_config', JSON.stringify({
        defaultPermissionMode: body.defaultPermissionMode ?? null,
        defaultWorkspaceId: body.defaultWorkspaceId ?? null,
        memoryModel: body.memoryModel ?? null,
      }));
      res.json({ ok: true, config: configDto(ctx) });
    } catch (err) {
      log.warn('update config failed', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'failed to update config', code: 'internal_error' });
      }
    }
  });
}
