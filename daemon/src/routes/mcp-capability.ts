import type { Express } from 'express';
import type { AppContext } from '../app/context.js';
import { resolveCapabilityScope } from '../capabilities/scope.js';
import type { CapabilityScopeDto } from '../types/api.js';

/**
 * Scope lookup for the `paboot_capability` MCP server. The agent only sends
 * its run id; workspace and end are resolved server-side.
 */
export function registerMcpCapabilityRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/internal/mcp/capability/scope', (req, res) => {
    const runId = req.query['runId'];
    if (typeof runId !== 'string' || runId === '') {
      res.status(400).json({ error: 'runId is required', code: 'bad_request' });
      return;
    }
    const run = ctx.db.getRun(runId);
    const session = run ? ctx.db.getSession(run.session_id) : undefined;
    if (!run || !session) {
      res.status(404).json({ error: 'run not found', code: 'run_not_found' });
      return;
    }
    const { workspace, end } = resolveCapabilityScope(ctx.db, session);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const dto: CapabilityScopeDto = {
      runId,
      sessionId: session.id,
      workspaceId: workspace.id,
      endId: end?.id ?? null,
      family: workspace.family === 'life' ? 'life' : 'dev',
    };
    res.json(dto);
  });
}
