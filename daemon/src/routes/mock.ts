import type { Express, Response } from 'express';
import type { AppContext } from '../app/context.js';
import { authRole } from '../http/auth.js';
import { sseHeaders } from '../http/sse.js';
import type { MockApiDto, MockModelResponse } from '../types/api.js';

function requireOperator(res: Response): boolean {
  if (authRole(res) === 'operator') return true;
  res.status(403).json({ error: 'operator token required', code: 'operator_required' });
  return false;
}

/**
 * Workspace-level mock model (Dev Space S2). Files are authoritative; the API
 * exists so the desktop can edit them and the agent can keep using Write/Edit.
 */
export function registerMockRoutes(app: Express, ctx: AppContext): void {
  app.get('/api/workspaces/:id/mock', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.family !== 'dev') {
      res.status(403).json({ error: 'mock is dev-only', code: 'capability_not_allowed' });
      return;
    }
    if (!ctx.mockStore) {
      res.status(503).json({ error: 'mock store unavailable', code: 'mock_unavailable' });
      return;
    }
    const dto: MockModelResponse = { model: ctx.mockStore.list(workspace.id) };
    res.json(dto);
  });

  app.put('/api/workspaces/:id/mock', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace) {
      res.status(404).json({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    if (workspace.family !== 'dev') {
      res.status(403).json({ error: 'mock is dev-only', code: 'capability_not_allowed' });
      return;
    }
    if (!ctx.mockStore) {
      res.status(503).json({ error: 'mock store unavailable', code: 'mock_unavailable' });
      return;
    }
    const apis = req.body?.['apis'];
    const rules = req.body?.['rules'];
    const remove = req.body?.['remove'];
    if (
      !Array.isArray(apis) ||
      (rules !== undefined && typeof rules !== 'string') ||
      (remove !== undefined && !Array.isArray(remove))
    ) {
      res.status(400).json({ error: 'apis and rules are required', code: 'bad_request' });
      return;
    }
    try {
      const model = ctx.mockStore.save(
        workspace.id,
        {
          apis: apis as MockApiDto[],
          rules: typeof rules === 'string' ? rules : '',
        },
        Array.isArray(remove) ? remove.filter((id): id is string => typeof id === 'string') : [],
      );
      const dto: MockModelResponse = { model };
      res.json(dto);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'bad_request',
      });
    }
  });

  app.get('/api/workspaces/:id/mock/stream', (req, res) => {
    if (!requireOperator(res)) return;
    const workspace = ctx.db.getWorkspace(req.params['id']!);
    if (!workspace || workspace.family !== 'dev' || !ctx.mockStore) {
      res.status(404).json({ error: 'mock not available', code: 'mock_unavailable' });
      return;
    }
    res.writeHead(200, sseHeaders());
    res.write(': connected\n\n');
    ctx.mockStore.subscribe(workspace.id, res);
  });
}
