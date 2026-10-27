import type { Express } from 'express';
import { VERSION } from '../version.js';
import type { AppContext } from '../app/context.js';
import { resolveServerId } from '../db/server-id.js';
import type { HealthDto } from '../types/api.js';

export function registerHealthRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/health', (_req, res) => {
    const workspace = ctx.db.getDefaultWorkspace();
    const body: HealthDto = {
      ok: true,
      service: 'paboot',
      version: VERSION,
      workspace: workspace?.path ?? ctx.config.workspace,
      // The one unauthenticated endpoint that answers "which daemon is this?".
      serverId: resolveServerId(ctx.db),
    };
    res.json(body);
  });
}
