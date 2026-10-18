import type { Express } from 'express';
import type { AppContext } from '../context.js';

export function registerAgentRoutes(app: Express, ctx: AppContext): void {
  // Primary runtime detection (Claude Code today).
  app.get('/api/agent', async (_req, res) => {
    const detection = await ctx.registry.detect('claude', process.env);
    res.json({ agent: detection });
  });

  // Enumerate registered runtimes with availability. The registry caches each
  // detection, so only the first call after boot pays for the probes — which is
  // why this is allowed to probe at all (it used to be a pure inventory read).
  app.get('/api/agents', async (_req, res) => {
    const agents = await Promise.all(
      ctx.registry.list().map(async (entry) => {
        const detection =
          ctx.registry.detection(entry.id) ?? (await ctx.registry.detect(entry.id, process.env));
        return {
          id: entry.id,
          name: entry.name,
          bin: entry.bin,
          available: detection?.available ?? false,
        };
      }),
    );
    res.json({ agents });
  });

  // Models offered by one runtime. Claude answers from its alias list; Codex
  // spawns a short-lived app-server (`model/list`) and Registry caches it.
  app.get('/api/agents/:id/models', async (req, res) => {
    const models = await ctx.registry.listModels(req.params.id, process.env);
    if (!models) {
      res.status(404).json({ error: `unknown runtime: ${req.params.id}`, code: 'unknown_runtime' });
      return;
    }
    res.json({ models });
  });
}
